import { Router, type IRouter } from "express";
import healthRouter from "./health";
import eventsRouter from "./events";
import circularsRouter from "./circulars";
import authRouter from "./auth";
import teamRouter from "./team";
import notesRouter from "./notes";
import discussionsRouter from "./discussions";
import bookmarksRouter from "./bookmarks";
import filterReportRouter from "./filterReport";
import notificationsRouter from "./notifications";
import notificationsWechatRouter from "./notificationsWechat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(eventsRouter);
router.use(circularsRouter);
router.use(authRouter);
router.use(teamRouter);
router.use(notesRouter);
router.use(discussionsRouter);
router.use(bookmarksRouter);
router.use(filterReportRouter);
router.use(notificationsRouter);
router.use(notificationsWechatRouter);

export default router;
