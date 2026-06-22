const mongoose = require("mongoose");

const announcementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Please provide a title"],
      trim: true,
      minlength: [5, "Title must be at least 5 characters"],
      maxlength: [100, "Title cannot exceed 100 characters"],
    },
    content: {
      type: String,
      required: [true, "Please provide content"],
      minlength: [10, "Content must be at least 10 characters"],
    },
    department: {
      type: String,
      required: [true, "Please provide a department"],
      enum: ["CSE", "EEE", "BBA", "English", "Law", "All"],
      default: "All",
    },
    priority: {
      type: String,
      enum: ["normal", "important", "urgent"],
      default: "normal",
    },
    pinned: {
      type: Boolean,
      default: false,
    },
    // Scheduled publishing: hidden from the public feed until publishAt.
    publishAt: {
      type: Date,
      default: Date.now,
    },
    // Optional auto-archive: hidden from the default feed after expiresAt.
    expiresAt: {
      type: Date,
    },
    // Guard so the scheduler broadcasts a scheduled announcement only once.
    notified: {
      type: Boolean,
      default: false,
    },
    // Per-user read receipts.
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    approved: {
      type: Boolean,
      default: false,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    rejectionReason: {
      type: String,
      default: "",
    },
    attachments: [
      {
        fileUrl: { type: String, required: true },
        fileType: { type: String, default: "FILE" },
        fileName: { type: String, default: "" },
        fileSize: { type: Number, default: 0 },
        mimeType: { type: String, default: "" },
        publicId: { type: String, default: "" },
        // Cloudinary resource_type ("image" | "raw") — needed for signed
        // download URLs and asset cleanup on delete.
        resourceType: { type: String, default: "raw" },
      },
    ],
  },
  {
    timestamps: true,
  }
);

announcementSchema.index({ approved: 1, department: 1, pinned: -1, publishAt: -1 });
announcementSchema.index({ expiresAt: 1 });

module.exports = mongoose.model("Announcement", announcementSchema);
