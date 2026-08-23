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

/**
 * Where an invitee goes to accept.
 *
 * PUBLIC_APP_URL is the deployment's externally reachable address. It is NOT
 * derivable from the request: behind the nginx/compose setup the api-server
 * sees an internal host and port, so building the link from req.headers.host
 * produces a URL that only resolves inside the Docker network.
 *
 * Falls back to localhost so a development invite is still clickable, and the
 * fallback is logged once so a production deployment that forgot to set it is
 * discoverable rather than silently mailing out unusable links.
 */
let _warnedMissingAppUrl = false;

function publicAppUrl(): string {
  const configured = process.env["PUBLIC_APP_URL"];
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, "");

  if (!_warnedMissingAppUrl) {
    _warnedMissingAppUrl = true;
    logger.warn(
      "[team] PUBLIC_APP_URL is not set — invitation links will point at localhost:5173 " +
        "and will not work for anyone outside this machine.",
    );
  }
  return "http://localhost:5173";
}

/**
 * The register form, with the invited address prefilled.
 *
 * The email must match: registration looks the invitation up BY EMAIL, so
 * signing up with a different address fails the check with "Registration
 * requires an invitation" and gives no hint why.
 */
function buildInviteUrl(email: string): string {
  return `${publicAppUrl()}/login?register=1&email=${encodeURIComponent(email)}`;
}

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

  // The link the invitee actually needs. Without it the email said "sign in at
  // the portal" and named no address, so even a delivered invitation left the
  // recipient with nowhere to go.
  //
  // The email is prefilled on the register tab because registration matches an
  // invitation BY EMAIL — signing up with a different address silently fails
  // the invitation check and returns "Registration requires an invitation".
  const inviteUrl = buildInviteUrl(targetEmail);
  const labName = lab?.name ?? "Transient Event Detection";

  // Delivery is REPORTED, never assumed.
  //
  // Two independent bugs made a failed invitation look successful: the SMTP
  // provider returns {success:false} rather than throwing, so the old
  // try/catch never fired; and the no-op provider used to return success
  // outright. The result is now inspected and passed back to the caller, so
  // an admin is told when an invitation was created but not delivered.
  let delivery: {
    sent: boolean;
    provider: string;
    skipped: boolean;
    error: string | null;
  };

  try {
    const provider = createEmailProvider();
    const result = await provider.send({
      to: targetEmail,
      subject: `You've been invited to join ${labName}`,
      text:
        `${actor.email} has invited you to join ${labName} as a ${validRole}.

` +
        `Accept the invitation by creating an account with THIS email address (${targetEmail}):
` +
        `${inviteUrl}

` +
        `The invitation expires on ${invitation.expiresAt.toUTCString()}.`,
      html:
        `<p><strong>${actor.email}</strong> has invited you to join ` +
        `<strong>${labName}</strong> as a <strong>${validRole}</strong>.</p>` +
        `<p><a href="${inviteUrl}">Accept the invitation</a></p>` +
        `<p>You must register with this email address: <strong>${targetEmail}</strong>.</p>` +
        `<p style="color:#64748b;font-size:12px">Expires ${invitation.expiresAt.toUTCString()}. ` +
        `If the link does not work, open ${inviteUrl}</p>`,
    });

    delivery = {
      sent: result.success,
      provider: provider.name,
      skipped: result.skipped === true,
      error: result.success ? null : (result.error ?? "Unknown email error"),
    };

    if (result.success) {
      logger.info({ targetEmail, provider: provider.name }, "[team] Invitation email sent");
    } else {
      logger.error(
        { targetEmail, provider: provider.name, skipped: result.skipped, error: result.error },
        "[team] Invitation created but the email was NOT delivered",
      );
    }
  } catch (err) {
    // A provider that throws rather than returning a result.
    const message = err instanceof Error ? err.message : String(err);
    delivery = { sent: false, provider: "unknown", skipped: false, error: message };
    logger.error({ err, targetEmail }, "[team] Invitation email threw — invitation was still created");
  }

  res.status(201).json({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    },
    /**
     * Always returned so the admin can act on a failure. `inviteUrl` is
     * included regardless of delivery: when mail is not configured, sharing
     * this link by hand is the whole recovery path.
     */
    delivery,
    inviteUrl,
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

