import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);

export default router;
