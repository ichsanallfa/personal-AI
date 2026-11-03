import express from "express";
import { getOsuStatus, playOsuMatch, resetOsuSkill } from "../controllers/osu.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requireOwner } from "../middlewares/role.middleware.js";

const router = express.Router();

router.get("/status", getOsuStatus);
router.post("/play", requireAuth, playOsuMatch);
router.post("/reset", requireAuth, requireOwner, resetOsuSkill);

export default router;
