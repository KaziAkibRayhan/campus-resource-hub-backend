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
    club: {
      type: String,
      required: [true, "Please provide a club name"],
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
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    approved: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Event", eventSchema);
