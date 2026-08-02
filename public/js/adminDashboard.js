(function initializeAdminDashboard() {
  'use strict';

  const parsePositivePage = value => {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return 1;

    const page = Number(value);
    return Number.isSafeInteger(page) ? page : 1;
  };

  const state = document.getElementById('admin-dashboard-state');
  let uploadPage = parsePositivePage(state?.dataset.uploadPage);
  let userPage = parsePositivePage(state?.dataset.userPage);
  const adminMediaRendering = window.CampPicsMedia;
  const csrf = window.CampPicsCsrf;

  function createAdminMediaLink(upload) {
    if (!adminMediaRendering) return null;

    let href;
    let thumbnailUrl;
    let alt;

    if (upload.mediaType === 'photo') {
      href = adminMediaRendering.getSafeHttpUrl(upload.adminPhotoUrl);
      thumbnailUrl = href;
      alt = 'photo thumbnail';
    } else if (upload.mediaType === 'video') {
      const videoId = adminMediaRendering.extractYouTubeId(upload.youtubeId);
      if (videoId) {
        href = `https://www.youtube.com/watch?v=${videoId}`;
        thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        alt = 'YouTube thumbnail';
      }
    }

    if (!href || !thumbnailUrl) return null;

    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.appendChild(adminMediaRendering.createImageElement({
      src: thumbnailUrl,
      alt,
      className: 'thumb',
      fallbackSrc: '',
    }));
    return link;
  }

  function createUploadRow(upload) {
    const row = document.createElement('div');
    row.className = 'upload-item';

    const summary = document.createElement('div');
    const mediaType = document.createElement('strong');
    mediaType.textContent = upload.mediaType == null
      ? ''
      : String(upload.mediaType);
    summary.append(
      mediaType,
      document.createTextNode(
        ` by ${upload.uploader?.fname || 'Unknown'} ` +
        `(${upload.uploader?.username || ''}) \u2014 ` +
        new Date(upload.createdAt).toLocaleString(),
      ),
    );

    const location = document.createElement('div');
    location.textContent =
      `Park: ${upload.parkName || 'N/A'}` +
      `${upload.campgroundName ? ` | CG: ${upload.campgroundName}` : ''}` +
      `${upload.campsiteName ? ` | Site: ${upload.campsiteName}` : ''}`;

    row.append(summary, location);
    const mediaLink = createAdminMediaLink(upload);
    if (mediaLink) row.appendChild(mediaLink);
    return row;
  }

  function createUserRow(user) {
    const row = document.createElement('div');
    row.className = 'user-item';

    const verification = document.createElement('span');
    verification.textContent = `[${Boolean(user.email_verified)}]`;
    verification.className =
      `admin-email-status${user.email_verified ? '' : ' admin-email-status--unverified'}`;

    const name = document.createElement('strong');
    name.textContent = user.fname == null ? '' : String(user.fname);
    row.append(
      verification,
      document.createTextNode(' - '),
      name,
      document.createTextNode(
        ` \u2014 ${user.username || ''} ` +
        `(joined ${new Date(user.date_created).toLocaleDateString()})`,
      ),
    );

    const action = user.blocked ? 'unblock' : 'block';
    const actionLabel = user.blocked ? 'Unblock' : 'Block';
    const form = document.createElement('form');
    form.action = `/a/user/${encodeURIComponent(String(user._id))}/${action}`;
    form.method = 'POST';
    form.className = 'inline-form user-status-form';
    form.dataset.action = action;

    const csrfField = document.createElement('input');
    csrfField.type = 'hidden';
    csrfField.name = '_csrf';
    csrfField.value = csrf?.getToken() || '';

    const button = document.createElement('button');
    button.type = 'submit';
    button.className = `${action}-btn`;
    button.textContent = actionLabel;

    form.append(csrfField, button);
    row.appendChild(form);
    return row;
  }

  async function fetchMoreUploads() {
    uploadPage++;
    const response = await fetch(`/a/dashboard?uploadPage=${uploadPage}`, {
      headers: { 'Accept': 'application/json' },
    });
    const data = await response.json();
    const uploads = document.getElementById('uploads');

    data.uploads.forEach(upload => {
      uploads?.appendChild(createUploadRow(upload));
    });

    if (!data.hasMoreUploads) {
      document.getElementById('loadMoreUploads')?.remove();
    }
  }

  async function fetchMoreUsers() {
    userPage++;
    const response = await fetch(`/a/dashboard?userPage=${userPage}`, {
      headers: { 'Accept': 'application/json' },
    });
    const data = await response.json();
    const users = document.getElementById('users');

    data.users.forEach(user => {
      users?.appendChild(createUserRow(user));
    });

    if (!data.hasMoreUsers) {
      document.getElementById('loadMoreUsers')?.remove();
    }
  }

  document.getElementById('loadMoreUploads')
    ?.addEventListener('click', fetchMoreUploads);
  document.getElementById('loadMoreUsers')
    ?.addEventListener('click', fetchMoreUsers);
  document.addEventListener('submit', event => {
    const form = event.target.closest?.('.user-status-form');
    if (!form) return;

    const action = form.dataset.action === 'unblock' ? 'Unblock' : 'Block';
    if (!window.confirm(`${action} this user?`)) event.preventDefault();
  });
})();
