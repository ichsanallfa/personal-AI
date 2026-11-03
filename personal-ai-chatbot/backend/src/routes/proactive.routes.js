import express from "express";
import {
  getProactiveStatus,
  triggerProactiveThought,
  toggleProactiveService,
} from "../controllers/proactive.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requireOwner } from "../middlewares/role.middleware.js";

const router = express.Router();

router.get("/status", getProactiveStatus);
router.post("/trigger", requireAuth, requireOwner, triggerProactiveThought);
router.post("/toggle", requireAuth, requireOwner, toggleProactiveService);

export default router;
