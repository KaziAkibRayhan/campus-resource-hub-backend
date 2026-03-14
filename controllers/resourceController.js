// backend/controllers/resourceController.js
const Resource = require("../models/Resource");
const cloudinary = require("../config/cloudinary");

// @desc    Upload a new resource
// @route   POST /api/resources
// @access  Private
exports.uploadResource = async (req, res) => {
  try {
    const { title, description, course, department, semester } = req.body;

    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file",
      });
    }

    // Get file type from mimetype
    const fileTypeMap = {
      "application/pdf": "PDF",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "DOCX",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation":
        "PPTX",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        "XLSX",
      "application/msword": "DOCX",
      "application/vnd.ms-powerpoint": "PPTX",
    };

    const fileType = fileTypeMap[req.file.mimetype] || "PDF";

    // Create resource
    const resource = await Resource.create({
      title,
      description,
      course,
      department,
      semester,
      fileUrl: req.file.path,
      fileType,
      fileSize: req.file.size,
      cloudinaryPublicId: req.file.filename,
      uploadedBy: req.user._id,
    });

    // Populate uploader info
    await resource.populate("uploadedBy", "name email studentId");

    res.status(201).json({
      success: true,
      message: "Resource uploaded successfully. Waiting for admin approval.",
      resource,
    });
  } catch (error) {
    console.error("Upload resource error:", error);

    // Delete uploaded file from Cloudinary if resource creation fails
    if (req.file && req.file.filename) {
      try {
        await cloudinary.uploader.destroy(req.file.filename, {
          resource_type: "raw",
        });
      } catch (deleteError) {
        console.error("Error deleting file from Cloudinary:", deleteError);
      }
    }

    res.status(500).json({
      success: false,
      message: error.message || "Error uploading resource",
    });
  }
};

// @desc    Get all resources (with filters)
// @route   GET /api/resources
// @access  Public
exports.getResources = async (req, res) => {
  try {
    const {
      department,
      semester,
      course,
      search,
      approved,
      isPending,
      sortBy = "createdAt",
      order = "desc",
      page = 1,
      limit = 10,
    } = req.query;

    // Build query
    const query = {};

    // Only show approved resources to non-admin users
    if (
      !req.user ||
      (req.user.role !== "admin" && req.user.role !== "moderator")
    ) {
      query.approved = true;
    } else if (isPending === "true") {
      query.approved = false;
      query.rejectionReason = { $exists: false };
    } else if (approved !== undefined) {
      query.approved = approved === "true";
    }

    // Filter by department
    if (department && department !== "all") {
      query.department = department;
    }

    // Filter by semester
    if (semester && semester !== "all") {
      query.semester = semester;
    }

    // Filter by course
    if (course) {
      query.course = new RegExp(course, "i");
    }

    // Search in title and description
    if (search) {
      query.$or = [
        { title: new RegExp(search, "i") },
        { description: new RegExp(search, "i") },
        { course: new RegExp(search, "i") },
      ];
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Sort options
    const sortOptions = {};
    sortOptions[sortBy] = order === "desc" ? -1 : 1;

    // Execute query
    const resources = await Resource.find(query)
      .populate("uploadedBy", "name email studentId")
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit));

    // Get total count
    const total = await Resource.countDocuments(query);

    res.status(200).json({
      success: true,
      count: resources.length,
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
      currentPage: parseInt(page),
      resources,
    });
  } catch (error) {
    console.error("Get resources error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching resources",
    });
  }
};

// @desc    Get single resource
// @route   GET /api/resources/:id
// @access  Public
exports.getResourceById = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id).populate(
      "uploadedBy",
      "name email studentId department"
    );

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    // Increment views
    resource.views += 1;
    await resource.save();

    res.status(200).json({
      success: true,
      resource,
    });
  } catch (error) {
    console.error("Get resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching resource",
    });
  }
};

// @desc    Update resource
// @route   PUT /api/resources/:id
// @access  Private (Owner only)
exports.updateResource = async (req, res) => {
  try {
    let resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    // Check if user is owner
    if (resource.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this resource",
      });
    }

    const { title, description, course, department, semester } = req.body;

    resource = await Resource.findByIdAndUpdate(
      req.params.id,
      {
        title,
        description,
        course,
        department,
        semester,
        approved: false,
        rejectionReason: undefined,
      },
      { new: true, runValidators: true }
    ).populate("uploadedBy", "name email studentId");

    res.status(200).json({
      success: true,
      message: "Resource updated successfully. Waiting for re-approval.",
      resource,
    });
  } catch (error) {
    console.error("Update resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating resource",
    });
  }
};

// @desc    Delete resource
// @route   DELETE /api/resources/:id
// @access  Private (Owner or Admin)
exports.deleteResource = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    // Check if user is owner or admin
    if (
      resource.uploadedBy.toString() !== req.user._id.toString() &&
      req.user.role !== "admin" &&
      req.user.role !== "moderator"
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this resource",
      });
    }

    // Delete file from Cloudinary
    try {
      await cloudinary.uploader.destroy(resource.cloudinaryPublicId, {
        resource_type: "raw",
      });
    } catch (error) {
      console.error("Error deleting from Cloudinary:", error);
    }

    await resource.deleteOne();

    res.status(200).json({
      success: true,
      message: "Resource deleted successfully",
    });
  } catch (error) {
    console.error("Delete resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting resource",
    });
  }
};

// @desc    Approve resource (Admin only)
// @route   PUT /api/resources/:id/approve
// @access  Private (Admin/Moderator)
exports.approveResource = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    resource.approved = true;
    resource.approvedBy = req.user._id;
    resource.approvedAt = Date.now();
    resource.rejectionReason = undefined;

    await resource.save();

    await resource.populate("uploadedBy", "name email");

    res.status(200).json({
      success: true,
      message: "Resource approved successfully",
      resource,
    });
  } catch (error) {
    console.error("Approve resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error approving resource",
    });
  }
};

// @desc    Reject resource (Admin only)
// @route   PUT /api/resources/:id/reject
// @access  Private (Admin/Moderator)
exports.rejectResource = async (req, res) => {
  try {
    const { reason } = req.body;

    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    resource.approved = false;
    resource.rejectionReason = reason || "Does not meet quality standards";

    await resource.save();

    res.status(200).json({
      success: true,
      message: "Resource rejected",
      resource,
    });
  } catch (error) {
    console.error("Reject resource error:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting resource",
    });
  }
};

// @desc    Increment download count
// @route   PUT /api/resources/:id/download
// @access  Private
exports.incrementDownload = async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({
        success: false,
        message: "Resource not found",
      });
    }

    resource.downloads += 1;
    await resource.save();

    res.status(200).json({
      success: true,
      downloads: resource.downloads,
    });
  } catch (error) {
    console.error("Increment download error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating download count",
    });
  }
};

// @desc    Get user's uploaded resources
// @route   GET /api/resources/my-uploads
// @access  Private
exports.getMyUploads = async (req, res) => {
  try {
    const resources = await Resource.find({ uploadedBy: req.user._id })
      .sort({ createdAt: -1 })
      .populate("approvedBy", "name");

    res.status(200).json({
      success: true,
      count: resources.length,
      resources,
    });
  } catch (error) {
    console.error("Get my uploads error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching your uploads",
    });
  }
};
