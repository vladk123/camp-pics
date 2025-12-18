import { User } from '../models/user.js';
import { Upload } from '../models/upload.js';

// import { logger } from '../utils/logging.js'; //for logging errors
// import { getIP } from '../utils/getIP.js'
import { redirectedFlash } from '../utils/redirectedFlash.js';


export const dashboard = async (req, res, next) => {
  try {
    // Pagination parameters
    const uploadPage = parseInt(req.query.uploadPage) || 1;
    const userPage = parseInt(req.query.userPage) || 1;
    const limitUploads = 10;
    const limitUsers = 50;

    const skipUploads = (uploadPage - 1) * limitUploads;
    const skipUsers = (userPage - 1) * limitUsers;

    // Get most recent uploads (10 per page)
    const uploads = await Upload.find({})
        .sort({ createdAt: -1 })
        .skip(skipUploads)
        .limit(limitUploads)
        .populate('userId', 'fname username') // show uploader info
        // .populate('parkId', 'name slug')
        // .populate('campgroundId', 'name slug') // only filled if campground exists
        // .populate('campsiteId', 'siteNumber slug') // only filled if campsite exists
        .lean();

    const totalUploads = await Upload.countDocuments();
    const hasMoreUploads = totalUploads > uploadPage * limitUploads;

    // Get most recent users (50 per page)
    const users = await User.find({_id: { $ne: req.user._id }})
      .sort({ date_created: -1 })
      .skip(skipUsers)
      .limit(limitUsers)
      .lean();

    const totalUsers = await User.countDocuments({ _id: { $ne: req.user._id } });
    const hasMoreUsers = totalUsers > userPage * limitUsers;

    // Respond differently depending on request type
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({
        uploads,
        users,
        hasMoreUploads,
        hasMoreUsers,
      });
    }

    // Regular render (first load)
    return res.render('admin/dashboard', {
			meta: {
				title: 'Admin', 
			},
      uploads,
      users,
      uploadPage,
      userPage,
      hasMoreUploads,
      hasMoreUsers,
      data:{} // data obj to avoid crashes
    });

  } catch (err) {
    console.error('Admin dashboard error:', err);
    return redirectedFlash(req, res, 'error', 'Failed to load dashboard.', '/');
  }
};

export const blockUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    await User.findByIdAndUpdate(id, { blocked: true });
    return redirectedFlash(req, res, 'success', 'User has been blocked.', '/a/dashboard');
  } catch (err) {
    console.error('Error blocking user:', err);
    return redirectedFlash(req, res, 'error', 'Failed to block user.', '/a/dashboard');
  }
};

export const unblockUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    await User.findByIdAndUpdate(id, { blocked: false });
    return redirectedFlash(req, res, 'success', 'User has been unblocked.', '/a/dashboard');
  } catch (err) {
    console.error('Error unblocking user:', err);
    return redirectedFlash(req, res, 'error', 'Failed to unblock user.', '/a/dashboard');
  }
};
