// shared/cloudinary.js
// Phase 0: not used yet. Phase 1+ uploads photos for borrow-return and laundry.

(function () {
  async function uploadToCloudinary(file, subfolder) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', CONFIG.CLOUDINARY_UPLOAD_PRESET);
    fd.append('folder', CONFIG.CLOUDINARY_FOLDER_PREFIX + (subfolder || ''));

    const url = `https://api.cloudinary.com/v1_1/${CONFIG.CLOUDINARY_CLOUD_NAME}/image/upload`;
    const res = await fetch(url, { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.secure_url;
  }

  window.uploadToCloudinary = uploadToCloudinary;
})();
