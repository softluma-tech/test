import express from "express";
import { handlePostbackData } from "../../services/traderService.js";
import logger from "../../utils/logger.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const data = req.body || {};
    const { uid, eid } = data;

    if (!uid || typeof uid !== "string") {
      return res.status(400).json({ error: "Missing or invalid uid" });
    }
    logger.info(
      `Postback: uid=${uid} eid=${eid || "none"} status=${data.status || "none"} ip=${req.ip}`,
    );

    const result = await handlePostbackData(data);

    if (result.success) {
      res.status(200).send("OK");
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    logger.error("Postback Router Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
