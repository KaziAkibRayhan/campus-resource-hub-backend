// backend/controllers/authController.js
const User = require('../models/User');
const AuthOtp = require("../models/AuthOtp");
const generateToken = require('../utils/generateToken');
const cloudinary = require("../config/cloudinary");
const crypto = require("crypto");
const { sendOtpEmail } = require("../utils/email");
const { normalizeStudentId } = require("../utils/authValidation");

const OTP_TTL_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();

const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

const hashOtp = (otp) =>
  crypto.createHash("sha256").update(`${otp}:${process.env.JWT_SECRET}`).digest("hex");

const createOtp = async ({ email, purpose }) => {
  const otp = generateOtp();
  await AuthOtp.findOneAndUpdate(
    { email, purpose },
    {
      email,
      purpose,
      otpHash: hashOtp(otp),
      attempts: 0,
      expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return otp;
};

const verifyOtpRecord = async ({ email, purpose, otp }) => {
  const record = await AuthOtp.findOne({ email, purpose });

  if (!record) {
    return { ok: false, status: 400, message: "OTP not found or expired. Please request a new code." };
  }

  if (record.expiresAt <= new Date()) {
    await record.deleteOne();
    return { ok: false, status: 400, message: "OTP expired. Please request a new code." };
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await record.deleteOne();
    return { ok: false, status: 429, message: "Too many incorrect attempts. Please request a new code." };
  }

  if (record.otpHash !== hashOtp(otp)) {
    record.attempts += 1;
    await record.save();
    return { ok: false, status: 400, message: "Invalid OTP code" };
  }

  return { ok: true, record };
};

const toUserResponse = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  studentId: user.studentId,
  department: user.department,
  role: user.role,
  profileImage: user.profileImage,
  emailVerified: user.emailVerified !== false,
});

// @desc    Register a new user
// @route   POST /api/auth/signup
// @access  Public
exports.signup = async (req, res) => {
  try {
    const { name, password, department } = req.body;
    const email = normalizeEmail(req.body.email);
    const studentId = normalizeStudentId(req.body.studentId);

    // Check if user already exists
    const userExists = await User.findOne({ email });
    if (userExists && userExists.emailVerified !== false) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists',
      });
    }

    // Check if student ID already exists
    const studentIdExists = await User.findOne({ studentId });
    if (studentIdExists && studentIdExists.email !== email) {
      return res.status(400).json({
        success: false,
        message: 'Student ID already registered',
      });
    }

    let user = userExists;

    if (user) {
      user.name = name;
      user.password = password;
      user.studentId = studentId;
      user.department = department;
      user.emailVerified = false;
      await user.save();
    } else {
      user = await User.create({
        name,
        email,
        password,
        studentId,
        department,
        emailVerified: false,
      });
    }

    const otp = await createOtp({ email, purpose: "signup" });
    await sendOtpEmail({ to: email, otp, purpose: "signup" });

    res.status(200).json({
      success: true,
      message: "Verification code sent to your email",
      email,
      expiresInMinutes: OTP_TTL_MINUTES,
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error during registration',
    });
  }
};

// @desc    Verify signup OTP and activate user
// @route   POST /api/auth/verify-signup-otp
// @access  Public
exports.verifySignupOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();

    const result = await verifyOtpRecord({ email, purpose: "signup", otp });
    if (!result.ok) {
      return res.status(result.status).json({
        success: false,
        message: result.message,
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      await result.record.deleteOne();
      return res.status(404).json({
        success: false,
        message: "Account not found. Please sign up again.",
      });
    }

    user.emailVerified = true;
    await user.save();
    await result.record.deleteOne();

    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      message: "Email verified successfully",
      token,
      user: toUserResponse(user),
    });
  } catch (error) {
    console.error("Verify signup OTP error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during email verification",
    });
  }
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate email & password
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password',
      });
    }

    // Check for user (include password for comparison)
    const user = await User.findOne({ email: normalizeEmail(email) }).select('+password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    // Check if user is blocked
    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been blocked. Please contact admin.',
      });
    }

    if (user.emailVerified === false) {
      return res.status(403).json({
        success: false,
        message: "Please verify your email before signing in.",
      });
    }

    // Check if password matches
    const isPasswordMatch = await user.matchPassword(password);

    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    // Generate token
    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        ...toUserResponse(user),
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login',
    });
  }
};

// @desc    Send password reset OTP
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const user = await User.findOne({ email });

    if (!user || user.emailVerified === false) {
      return res.status(200).json({
        success: true,
        message: "If an account exists, a reset code has been sent.",
      });
    }

    const otp = await createOtp({ email, purpose: "password_reset" });
    await sendOtpEmail({ to: email, otp, purpose: "password_reset" });

    res.status(200).json({
      success: true,
      message: "If an account exists, a reset code has been sent.",
      expiresInMinutes: OTP_TTL_MINUTES,
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({
      success: false,
      message: "Error sending password reset code",
    });
  }
};

// @desc    Verify password reset OTP
// @route   POST /api/auth/verify-reset-otp
// @access  Public
exports.verifyResetOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();

    const result = await verifyOtpRecord({ email, purpose: "password_reset", otp });
    if (!result.ok) {
      return res.status(result.status).json({
        success: false,
        message: result.message,
      });
    }

    res.status(200).json({
      success: true,
      message: "OTP verified. You can reset your password now.",
    });
  } catch (error) {
    console.error("Verify reset OTP error:", error);
    res.status(500).json({
      success: false,
      message: "Error verifying password reset code",
    });
  }
};

// @desc    Reset password using OTP
// @route   POST /api/auth/reset-password
// @access  Public
exports.resetPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();
    const { newPassword } = req.body;

    const result = await verifyOtpRecord({ email, purpose: "password_reset", otp });
    if (!result.ok) {
      return res.status(result.status).json({
        success: false,
        message: result.message,
      });
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user || user.emailVerified === false) {
      await result.record.deleteOne();
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    user.password = newPassword;
    await user.save();
    await result.record.deleteOne();

    res.status(200).json({
      success: true,
      message: "Password reset successfully. Please sign in with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      success: false,
      message: "Error resetting password",
    });
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    res.status(200).json({
      success: true,
      user: toUserResponse(user),
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/update-profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    const { name, email, department, currentPassword, newPassword } = req.body;

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Check if email is being changed and if it already exists
    if (email && email !== user.email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) {
        return res.status(400).json({
          success: false,
          message: 'Email already in use',
        });
      }
    }

    // Update fields
    user.name = name || user.name;
    user.email = email || user.email;
    user.department = department || user.department;

    if (req.file) {
      if (user.profileImagePublicId) {
        try {
          await cloudinary.uploader.destroy(user.profileImagePublicId);
        } catch (deleteError) {
          console.error("Profile image delete error:", deleteError);
        }
      }

      user.profileImage = req.file.path;
      user.profileImagePublicId = req.file.filename;
    }

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          message: "Current password is required to set a new password",
        });
      }

      const userWithPassword = await User.findById(req.user.id).select("+password");
      const isPasswordMatch = await userWithPassword.matchPassword(currentPassword);

      if (!isPasswordMatch) {
        return res.status(401).json({
          success: false,
          message: "Current password is incorrect",
        });
      }

      user.password = newPassword;
    }

    const updatedUser = await user.save();

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: toUserResponse(updatedUser),
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

// @desc    Change password
// @route   PUT /api/auth/change-password
// @access  Private
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current and new password',
      });
    }

    const user = await User.findById(req.user.id).select('+password');

    // Check current password
    const isPasswordMatch = await user.matchPassword(currentPassword);

    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect',
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    // Generate new token
    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      message: 'Password changed successfully',
      token,
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};
