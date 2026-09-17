

import mongoose from "mongoose";

const configSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String },
  },
  { timestamps: true },
);

export const Config = mongoose.model("Config", configSchema);
