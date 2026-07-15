// backend/models/Resource.js
const mongoose = require("mongoose");

const resourceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Please provide a title"],
      trim: true,
      minlength: [5, "Title must be at least 5 characters"],
      maxlength: [100, "Title cannot exceed 100 characters"],
    },
    description: {
      type: String,
      required: [true, "Please provide a description"],
      minlength: [10, "Description must be at least 10 characters"],
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    course: {
      type: String,
      required: [true, "Please provide a course code"],
      trim: true,
    },
    department: {
      type: String,
      required: [true, "Please provide a department"],
      enum: ["CSE", "EEE", "BBA", "English", "Law"],
    },
    semester: {
      type: String,
      required: [true, "Please provide a semester"],
      enum: ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"],
    },
    fileUrl: {
      type: String,
      required: [true, "File URL is required"],
    },
    fileType: {
      type: String,
      required: [true, "File type is required"],
      enum: ["PDF", "DOCX", "PPTX", "XLSX", "IMAGE"],
    },
    fileSize: {
      type: Number, // in bytes
      required: true,
    },
    cloudinaryPublicId: {
      type: String,
      required: true,
    },
    cloudinaryResourceType: {
      type: String,
      enum: ["raw", "image"],
      default: "raw",
    },
    uploadedBy: {
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
    approvedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
    },
    // Automated content-safety check result.
    // "approved": fully scanned and clean; "partial": clean but some content
    // could not be scanned (legacy formats, undecodable images);
    // "skipped": no moderation provider was reachable — needs admin review.
    moderation: {
      status: {
        type: String,
        enum: ["approved", "partial", "skipped"],
        default: "skipped",
      },
      // true when the AI flagged this upload as potentially harmful/adult.
      // Flagged items are held unpublished for an admin/moderator to review
      // and then publish or reject.
      flagged: {
        type: Boolean,
        default: false,
      },
      // Human-readable categories the AI flagged (e.g. "sexual or nude
      // content", "violent content"), shown to admins in the review queue.
      categories: {
        type: [String],
        default: [],
      },
      provider: String,
      checkedAt: Date,
    },
    downloads: {
      type: Number,
      default: 0,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    ratingCount: {
      type: Number,
      default: 0,
    },
    views: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Index for faster queries
resourceSchema.index({ department: 1, semester: 1, approved: 1 });
resourceSchema.index({ course: 1 });
resourceSchema.index({ uploadedBy: 1 });
resourceSchema.index({ createdAt: -1 });

// Virtual for uploader name
resourceSchema.virtual("uploaderName").get(function () {
  return this.uploadedBy ? this.uploadedBy.name : "Unknown";
});

// Ensure virtuals are included in JSON
resourceSchema.set("toJSON", { virtuals: true });
resourceSchema.set("toObject", { virtuals: true });

resourceSchema.plugin(require("../utils/embeddingSync").embeddingPlugin, { type: "resource" });

module.exports = mongoose.model("Resource", resourceSchema);
