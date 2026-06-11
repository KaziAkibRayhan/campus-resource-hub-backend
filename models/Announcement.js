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

announcementSchema.index({ approved: 1, department: 1, createdAt: -1 });

module.exports = mongoose.model("Announcement", announcementSchema);
