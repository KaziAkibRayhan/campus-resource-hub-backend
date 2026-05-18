const mongoose = require("mongoose");

const lostFoundItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["lost", "found"],
      required: [true, "Please provide item type"],
    },
    item: {
      type: String,
      required: [true, "Please provide item name"],
      trim: true,
      minlength: [3, "Item name must be at least 3 characters"],
      maxlength: [80, "Item name cannot exceed 80 characters"],
    },
    description: {
      type: String,
      required: [true, "Please provide a description"],
      minlength: [10, "Description must be at least 10 characters"],
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    location: {
      type: String,
      required: [true, "Please provide a location"],
      trim: true,
      maxlength: [120, "Location cannot exceed 120 characters"],
    },
    contact: {
      type: String,
      required: [true, "Please provide contact information"],
      trim: true,
      maxlength: [120, "Contact cannot exceed 120 characters"],
    },
    imageUrl: {
      type: String,
      default: "",
    },
    cloudinaryPublicId: {
      type: String,
      default: "",
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
    approvedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["open", "claimed", "resolved"],
      default: "open",
    },
  },
  { timestamps: true }
);

lostFoundItemSchema.index({ approved: 1, type: 1, status: 1, createdAt: -1 });
lostFoundItemSchema.index({ postedBy: 1, createdAt: -1 });

module.exports = mongoose.model("LostFoundItem", lostFoundItemSchema);
