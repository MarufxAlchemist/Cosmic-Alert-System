import { Router } from "express";
import { db, labMembers, users, labs, labInvitations } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireAdmin, AuthPayload } from "../middlewares/auth.js";
import { createEmailProvider } from "../notifications/emailService.js";
import { logger } from "../lib/logger.js";
import type { Request } from "express";
import crypto from "crypto";

const router = Router();

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// GET /team — any authenticated researcher
router.get("/team", requireAuth, async (req, res) => {
  const actor = (req as Request & { user: AuthPayload }).user;

  // Get actor's lab (assuming first lab for simplicity, or should join)
  const [actorMember] = await db.select().from(labMembers).where(eq(labMembers.userId, actor.userId as any)).limit(1);
  if (!actorMember) {
    res.json({ members: [] });
    return;
  }

  const members = await db
    .select({
      id: labMembers.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: labMembers.role,
      createdAt: labMembers.joinedAt,
    })
    .from(labMembers)
    .innerJoin(users, eq(labMembers.userId, users.id))
    .where(eq(labMembers.labId, actorMember.labId))
    .orderBy(labMembers.joinedAt);

  res.json({
    members: members.map(m => ({
      ...m,
      id: String(m.id) // Convert BigInt to string for JSON serialization
    }))
  });
});

// POST /team — admin only
router.post("/team", requireAdmin, async (req, res) => {
  const actor = (req as Request & { user: AuthPayload }).user;
  const { email, name, role } = req.body as { email?: string; name?: string; role?: string };

  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Invalid email format" });
    return;
  }

  const validRole = role === "admin" ? "admin" : "researcher";

  const [actorMember] = await db.select().from(labMembers).where(eq(labMembers.userId, actor.userId as any)).limit(1);
  if (!actorMember) {
    res.status(403).json({ error: "Actor is not in a lab" });
    return;
  }

  const targetEmail = email.toLowerCase();

  // Find or create user
  let [targetUser] = await db.select().from(users).where(eq(users.email, targetEmail)).limit(1);
  if (!targetUser) {
    const randomPassword = crypto.randomBytes(16).toString("hex");
    [targetUser] = await db.insert(users).values({
      email: targetEmail,
      name: name ?? targetEmail.split("@")[0] ?? "Researcher",
      passwordHash: randomPassword,
    }).returning();
  }

  // Check if already in lab
  const existing = await db.select().from(labMembers)
    .where(and(eq(labMembers.userId, targetUser.id), eq(labMembers.labId, actorMember.labId)))
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: "Member already on team" });
    return;
  }

  const [member] = await db
    .insert(labMembers)
    .values({
      labId: actorMember.labId,
      userId: targetUser.id,
      role: validRole,
    })
    .returning();

  res.status(201).json({
    member: {
      id: String(member.id),
      userId: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role: member.role,
      createdAt: member.joinedAt
    }
  });
});

// DELETE /team/:id — admin only
router.delete("/team/:id", requireAdmin, async (req, res) => {
  const idStr = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idStr || typeof idStr !== "string") {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  let id: bigint;
  try {
    id = BigInt(idStr);
  } catch (e) {
    res.status(400).json({ error: "Invalid id format" });
    return;
  }

  const [deleted] = await db.delete(labMembers).where(eq(labMembers.id, id as any)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  res.json({ ok: true });
});

// GET /team/invitations — any authenticated researcher (pending invites for their lab)
router.get("/team/invitations", requireAuth, async (req, res) => {
  const actor = (req as Request & { user: AuthPayload }).user;

  const [actorMember] = await db.select().from(labMembers).where(eq(labMembers.userId, actor.userId as any)).limit(1);
  if (!actorMember) {
    res.json({ invitations: [] });
    return;
  }

  const invitations = await db
    .select()
    .from(labInvitations)
    .where(and(eq(labInvitations.labId, actorMember.labId), eq(labInvitations.status, "pending")))
    .orderBy(labInvitations.createdAt);

  res.json({
    invitations: invitations.map(i => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    })),
  });
});

// POST /team/invitations — admin only
router.post("/team/invitations", requireAdmin, async (req, res) => {
  const actor = (req as Request & { user: AuthPayload }).user;
  const { email, role } = req.body as { email?: string; role?: string };

  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Invalid email format" });
    return;
  }

  const validRole = role === "admin" ? "admin" : "researcher";
  const targetEmail = email.toLowerCase();

  const [actorMember] = await db.select().from(labMembers).where(eq(labMembers.userId, actor.userId as any)).limit(1);
  if (!actorMember) {
    res.status(403).json({ error: "Actor is not in a lab" });
    return;
  }

  const [existingUser] = await db.select().from(users).where(eq(users.email, targetEmail)).limit(1);
  if (existingUser) {
    const [existingMember] = await db.select().from(labMembers)
      .where(and(eq(labMembers.userId, existingUser.id), eq(labMembers.labId, actorMember.labId)))
      .limit(1);
    if (existingMember) {
      res.status(409).json({ error: "Member already on team" });
      return;
    }
  }

  const [existingInvite] = await db.select().from(labInvitations)
    .where(and(
      eq(labInvitations.labId, actorMember.labId),
      eq(labInvitations.email, targetEmail),
      eq(labInvitations.status, "pending"),
    ))
    .limit(1);
  if (existingInvite) {
    res.status(409).json({ error: "An invitation is already pending for this email" });
    return;
  }

  const [lab] = await db.select().from(labs).where(eq(labs.id, actorMember.labId)).limit(1);

  const [invitation] = await db
    .insert(labInvitations)
    .values({
      labId: actorMember.labId,
      invitedBy: actor.userId as any,
      email: targetEmail,
      role: validRole,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    })
    .returning();

  if (!invitation) {
    res.status(500).json({ error: "Failed to create invitation" });
    return;
  }

  try {
    const provider = createEmailProvider();
    await provider.send({
      to: targetEmail,
      subject: `You've been invited to join ${lab?.name ?? "Transient Event Detection"}`,
      text: `${actor.email} has invited you to join ${lab?.name ?? "Transient Event Detection"} as a ${validRole}. Sign in at the Transient Event Detection portal and register with this email address to accept.`,
      html: `<p><strong>${actor.email}</strong> has invited you to join <strong>${lab?.name ?? "Transient Event Detection"}</strong> as a <strong>${validRole}</strong>.</p><p>Sign in at the Transient Event Detection portal and register with this email address to accept the invitation.</p>`,
    });
  } catch (err) {
    logger.warn({ err, targetEmail }, "[team] Failed to send invitation email — invitation was still created");
  }

  res.status(201).json({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    },
  });
});

// DELETE /team/invitations/:id — admin only
router.delete("/team/invitations/:id", requireAdmin, async (req, res) => {
  const idStr = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!idStr) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [deleted] = await db.delete(labInvitations).where(eq(labInvitations.id, idStr)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Invitation not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;

