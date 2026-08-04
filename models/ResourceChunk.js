const mongoose = require("mongoose");

const resourceChunkSchema = new mongoose.Schema(
  {
    resource: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Resource",
      required: true,
      index: true,
    },
    order: { type: Number, required: true },
    kind: {
      type: String,
      enum: ["text", "image-description"],
      required: true,
    },
    label: { type: String, trim: true },
    text: { type: String, required: true, maxlength: 2200 },
    embedding: { type: [Number], select: false },
  },
  { timestamps: true }
);

resourceChunkSchema.index({ resource: 1, order: 1 }, { unique: true });
resourceChunkSchema.index({ text: "text" });

module.exports = mongoose.model("ResourceChunk", resourceChunkSchema);
