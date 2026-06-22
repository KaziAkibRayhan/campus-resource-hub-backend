const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema(
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
    },
    // Denormalized club name (display + legacy). clubRef is the real link when
    // the event belongs to a registered club.
    club: {
      type: String,
      required: [true, "Please provide a club name"],
    },
    clubRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Club",
    },
    date: {
      type: Date,
      required: [true, "Please provide a date"],
    },
    time: {
      type: String,
      required: [true, "Please provide a time"],
    },
    location: {
      type: String,
      required: [true, "Please provide a location"],
    },
    // 0 = unlimited capacity.
    capacity: {
      type: Number,
      default: 0,
      min: [0, "Capacity cannot be negative"],
    },
    status: {
      type: String,
      enum: ["scheduled", "cancelled"],
      default: "scheduled",
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
    registrations: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        status: {
          type: String,
          enum: ["going", "maybe", "declined"],
          default: "going",
        },
        registeredAt: {
          type: Date,
          default: Date.now,
        },
        updatedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

eventSchema.index({ approved: 1, status: 1, date: 1 });
eventSchema.index({ clubRef: 1, date: 1 });
eventSchema.index({ "registrations.user": 1 });

module.exports = mongoose.model("Event", eventSchema);
