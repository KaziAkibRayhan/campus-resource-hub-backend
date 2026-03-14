// backend/config/cloudinary.js
const cloudinary = require("cloudinary").v2;

// Configure Cloudinary
if (
  process.env.CLOUDINARY_CLOUD_NAME === "your_cloud_name" ||
  process.env.CLOUDINARY_API_KEY === "your_api_key" ||
  process.env.CLOUDINARY_API_SECRET === "your_api_secret"
) {
  console.warn(
    "⚠️  Cloudinary is using placeholder credentials. File uploads will fail. Please update your .env file with actual Cloudinary keys."
  );
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;
