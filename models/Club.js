const mongoose = require("mongoose");

const clubSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please provide a club name"],
      trim: true,
      unique: true,
      maxlength: [80, "Club name cannot exceed 80 characters"],
    },
    description: {
      type: String,
      required: [true, "Please provide a description"],
      minlength: [10, "Description must be at least 10 characters"],
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    category: {
      type: String,
      default: "General",
      trim: true,
    },
    // "open" = join instantly; "request" = an officer must approve.
    joinPolicy: {
      type: String,
      enum: ["open", "request"],
      default: "open",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    members: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        role: {
          type: String,
          enum: ["member", "officer"],
          default: "member",
        },
        joinedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    joinRequests: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        note: { type: String, trim: true, maxlength: 300, default: "" },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    approved: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

clubSchema.index({ approved: 1, category: 1, name: 1 });
clubSchema.index({ "members.user": 1 });

module.exports = mongoose.model("Club", clubSchema);
