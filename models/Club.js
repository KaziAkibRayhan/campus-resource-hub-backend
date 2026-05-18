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
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    moderators: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    members: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        joinedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    approved: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

clubSchema.index({ approved: 1, name: 1 });

module.exports = mongoose.model("Club", clubSchema);
