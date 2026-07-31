import mongoose from "mongoose";

const emailSchema = new mongoose.Schema({
  to: String,
  template: String,
  subject: { type: String, select: false },
  html: { type: String, select: false },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  messageId: String,
  sentAt: { type: Date, default: Date.now }
});

export const Email = mongoose.model("Email", emailSchema);
