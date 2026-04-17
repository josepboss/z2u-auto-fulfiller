import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import adminRouter from "./admin.js";
import lfollowersRouter from "./lfollowers.js";
import processOrderRouter from "./processOrder.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(adminRouter);
router.use(lfollowersRouter);
router.use(processOrderRouter);

export default router;
