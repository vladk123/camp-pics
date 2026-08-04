(function initializeAdminDashboard() {
  'use strict';

  const UPLOAD_FAILURE_MESSAGE =
    'Unable to load more uploads. Please try again.';
  const USER_FAILURE_MESSAGE =
    'Unable to load more users. Please try again.';
  const DASHBOARD_PARK_URL_PATTERN =
    /^\/camp\/park\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
  const DASHBOARD_CAMPGROUND_URL_PATTERN =
    /^\/camp\/park\/[a-z0-9]+(?:-[a-z0-9]+)*#[a-z0-9]+(?:-[a-z0-9]+)*$/u;
  const DASHBOARD_CAMPSITE_URL_PATTERN =
    /^\/camp\/park\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/campground\/[a-z0-9]+(?:-[a-z0-9]+)*)?\/campsite\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
  const DASHBOARD_USER_DETAIL_URL_PATTERN =
    /^\/a\/users\/[a-f0-9]{24}$/u;

  const parsePositivePage = value => {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return 1;

    const page = Number(value);
    return Number.isSafeInteger(page) ? page : 1;
  };

  const state = document.getElementById('admin-dashboard-state');
  if (!state || state.dataset.dashboardInitialized === 'true') return;
  state.dataset.dashboardInitialized = 'true';

  let uploadPage = parsePositivePage(state.dataset.uploadPage);
  let userPage = parsePositivePage(state.dataset.userPage);
  let uploadsLoading = false;
  let usersLoading = false;

  const adminMediaRendering = window.CampPicsMedia;
  const csrf = window.CampPicsCsrf;
  const uploadsContainer = document.getElementById('uploads');
  const usersContainer = document.getElementById('users');
  const uploadButton = document.getElementById('loadMoreUploads');
  const userButton = document.getElementById('loadMoreUsers');
  const uploadsStatus = document.getElementById('uploadsStatus');
  const usersStatus = document.getElementById('usersStatus');
  const uploadsEmpty = document.getElementById('uploadsEmpty');
  const usersEmpty = document.getElementById('usersEmpty');
  const uploadsVisibleCount = document.getElementById('uploadsVisibleCount');
  const usersVisibleCount = document.getElementById('usersVisibleCount');

  function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text == null ? '' : String(text);
    return element;
  }

  function formatDate(value, includeTime) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return {
        dateTime: '',
        label: includeTime ? 'Upload date unavailable' : 'Date unavailable',
      };
    }

    return {
      dateTime: date.toISOString(),
      label: includeTime ? date.toLocaleString() : date.toLocaleDateString(),
    };
  }

  function createAdminMediaLink(upload) {
    if (!adminMediaRendering) return null;

    let href;
    let thumbnailUrl;
    let alt;
    let label;

    if (upload.mediaType === 'photo') {
      href = adminMediaRendering.getSafeHttpUrl(upload.adminPhotoUrl);
      thumbnailUrl = href;
      alt = 'Photo upload preview';
      label = 'Open photo';
    } else if (upload.mediaType === 'video') {
      const videoId = adminMediaRendering.extractYouTubeId(upload.youtubeId);
      if (videoId) {
        href = `https://www.youtube.com/watch?v=${videoId}`;
        thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        alt = 'YouTube video preview';
        label = 'Open video';
      }
    }

    if (!href || !thumbnailUrl) return null;

    const link = document.createElement('a');
    link.className = 'admin-upload-card__media-link';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append(
      adminMediaRendering.createImageElement({
        src: thumbnailUrl,
        alt,
        className: 'thumb admin-upload-card__thumbnail',
        fallbackSrc: '',
      }),
      createTextElement('span', '', label),
    );
    return link;
  }

  function createDashboardLocationValue(value, url, pattern) {
    const valueElement = document.createElement('dd');
    const visibleName = value == null ? '' : String(value);
    if (
      typeof url !== 'string' ||
      !pattern?.test(url)
    ) {
      valueElement.textContent = visibleName;
      return valueElement;
    }

    const link = createTextElement(
      'a',
      'admin-upload-card__location-link',
      visibleName,
    );
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    valueElement.append(link);
    return valueElement;
  }

  function createUploadDetail(
    label,
    value,
    locationUrl = null,
    locationPattern = null,
  ) {
    const group = document.createElement('div');
    group.append(
      createTextElement('dt', '', label),
      createDashboardLocationValue(value, locationUrl, locationPattern),
    );
    return group;
  }

  function createUploadRow(upload) {
    const row = document.createElement('article');
    row.className = 'upload-item admin-upload-card';

    const media = document.createElement('div');
    media.className = 'admin-upload-card__media';
    const mediaLink = createAdminMediaLink(upload);
    media.append(mediaLink || createTextElement(
      'div',
      'admin-upload-card__placeholder',
      'Preview unavailable',
    ));

    const content = document.createElement('div');
    content.className = 'admin-upload-card__content';
    const header = document.createElement('header');
    header.className = 'admin-upload-card__header';
    const mediaType = upload.mediaType === 'photo'
      ? 'Photo'
      : upload.mediaType === 'video'
        ? 'Video'
        : 'Unknown media';
    const mediaBadge = createTextElement(
      'span',
      'admin-status-badge admin-status-badge--media',
      mediaType,
    );
    const uploadDate = formatDate(upload.createdAt, true);
    const time = createTextElement('time', '', uploadDate.label);
    if (uploadDate.dateTime) time.dateTime = uploadDate.dateTime;
    const badges = document.createElement('div');
    badges.className = 'admin-upload-card__badges';
    badges.append(mediaBadge);
    const drawLabels = {
      pending: 'Eligible (legacy)',
      eligible: 'Eligible',
      ineligible: 'Ineligible',
    };
    if (Object.hasOwn(drawLabels, upload.monthlyDrawStatus)) {
      badges.append(createTextElement(
        'span',
        `admin-status-badge admin-status-badge--draw admin-status-badge--draw-${upload.monthlyDrawStatus}`,
        `Draw: ${drawLabels[upload.monthlyDrawStatus]}`,
      ));
    }
    header.append(badges, time);

    const details = document.createElement('dl');
    details.className = 'admin-upload-card__details';
    const uploader = document.createElement('div');
    const uploaderValue = document.createElement('dd');
    uploaderValue.append(createTextElement(
      'strong',
      '',
      upload.uploader?.fname || 'Unknown',
    ));
    if (upload.uploader?.username) {
      uploaderValue.append(createTextElement(
        'span',
        '',
        upload.uploader.username,
      ));
    }
    uploader.append(createTextElement('dt', '', 'Uploader'), uploaderValue);
    details.append(
      uploader,
      createUploadDetail(
        'Park',
        upload.parkName || 'Not recorded',
        upload.parkUrl,
        DASHBOARD_PARK_URL_PATTERN,
      ),
    );
    if (upload.campgroundName) {
      details.append(createUploadDetail(
        'Campground',
        upload.campgroundName,
        upload.campgroundUrl,
        DASHBOARD_CAMPGROUND_URL_PATTERN,
      ));
    }
    if (upload.campsiteName) {
      details.append(createUploadDetail(
        'Campsite',
        upload.campsiteName,
        upload.campsiteUrl,
        DASHBOARD_CAMPSITE_URL_PATTERN,
      ));
    }

    content.append(header, details);
    row.append(media, content);
    return row;
  }

  function createUserCell(label, modifierClass = '') {
    const cell = document.createElement('td');
    cell.className = `admin-user-cell${modifierClass}`;
    cell.dataset.label = label;
    return cell;
  }

  function createUserRow(user) {
    const row = document.createElement('tr');
    row.className = 'user-item admin-user-row';

    const identity = createUserCell('User', ' admin-user-cell--identity');
    const identityName = createTextElement(
      'strong',
      '',
      user.fname || 'Unnamed user',
    );
    if (
      typeof user.userDetailUrl === 'string' &&
      DASHBOARD_USER_DETAIL_URL_PATTERN.test(user.userDetailUrl)
    ) {
      const detailLink = createTextElement(
        'a',
        'admin-user-detail-link',
        identityName.textContent,
      );
      detailLink.href = user.userDetailUrl;
      identityName.textContent = '';
      identityName.append(detailLink);
    }
    identity.append(identityName, createTextElement(
      'span',
      '',
      user.username || 'Email unavailable',
    ));

    const emailStatus = createUserCell('Email status');
    emailStatus.append(createTextElement(
      'span',
      `admin-email-status${
        user.email_verified ? '' : ' admin-email-status--unverified'
      }`,
      user.email_verified ? 'Verified' : 'Unverified',
    ));

    const accountStatus = createUserCell('Account status');
    accountStatus.append(createTextElement(
      'span',
      `admin-account-status${
        user.blocked ? ' admin-account-status--blocked' : ''
      }`,
      user.blocked ? 'Blocked' : 'Active',
    ));

    const joined = createUserCell('Joined');
    const joinedDate = formatDate(user.date_created, false);
    const joinedTime = createTextElement('time', '', joinedDate.label);
    if (joinedDate.dateTime) joinedTime.dateTime = joinedDate.dateTime;
    joined.append(joinedTime);

    const actionCell = createUserCell('Action', ' admin-user-cell--action');
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

    const button = createTextElement(
      'button',
      `${action}-btn`,
      actionLabel,
    );
    button.type = 'submit';
    form.append(csrfField, button);
    actionCell.append(form);

    row.append(identity, emailStatus, accountStatus, joined, actionCell);
    return row;
  }

  function clearStatus(status) {
    if (!status) return;
    if (typeof status.replaceChildren === 'function') {
      status.replaceChildren();
    } else {
      status.textContent = '';
    }
    status.classList.remove('admin-pagination-status--error');
  }

  function showFailure(status, message) {
    if (!status) return;
    status.textContent = message;
    status.classList.add('admin-pagination-status--error');
  }

  function updateVisibleCount(container, counter) {
    if (!container || !counter) return;
    counter.textContent = String(container.children.length);
  }

  async function fetchMoreUploads() {
    if (!uploadButton || uploadsLoading) return;

    uploadsLoading = true;
    const originalText = uploadButton.textContent;
    let buttonRemoved = false;
    uploadButton.disabled = true;
    uploadButton.textContent = 'Loading\u2026';
    clearStatus(uploadsStatus);

    try {
      const nextPage = uploadPage + 1;
      const response = await fetch(`/a/dashboard?uploadPage=${nextPage}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!response || response.ok === false) throw new Error('Upload page failed.');
      const data = await response.json();
      if (!Array.isArray(data.uploads)) throw new Error('Invalid upload page.');

      data.uploads.forEach(upload => {
        uploadsContainer?.append(createUploadRow(upload));
      });
      uploadPage = nextPage;
      if (data.uploads.length > 0 && uploadsEmpty) uploadsEmpty.hidden = true;
      updateVisibleCount(uploadsContainer, uploadsVisibleCount);

      if (!data.hasMoreUploads) {
        buttonRemoved = true;
        uploadButton.remove();
      }
    } catch {
      showFailure(uploadsStatus, UPLOAD_FAILURE_MESSAGE);
    } finally {
      uploadsLoading = false;
      if (!buttonRemoved) {
        uploadButton.disabled = false;
        uploadButton.textContent = originalText;
      }
    }
  }

  async function fetchMoreUsers() {
    if (!userButton || usersLoading) return;

    usersLoading = true;
    const originalText = userButton.textContent;
    let buttonRemoved = false;
    userButton.disabled = true;
    userButton.textContent = 'Loading\u2026';
    clearStatus(usersStatus);

    try {
      const nextPage = userPage + 1;
      const response = await fetch(`/a/dashboard?userPage=${nextPage}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!response || response.ok === false) throw new Error('User page failed.');
      const data = await response.json();
      if (!Array.isArray(data.users)) throw new Error('Invalid user page.');

      data.users.forEach(user => {
        usersContainer?.append(createUserRow(user));
      });
      userPage = nextPage;
      if (data.users.length > 0 && usersEmpty) usersEmpty.hidden = true;
      updateVisibleCount(usersContainer, usersVisibleCount);

      if (!data.hasMoreUsers) {
        buttonRemoved = true;
        userButton.remove();
      }
    } catch {
      showFailure(usersStatus, USER_FAILURE_MESSAGE);
    } finally {
      usersLoading = false;
      if (!buttonRemoved) {
        userButton.disabled = false;
        userButton.textContent = originalText;
      }
    }
  }

  uploadButton?.addEventListener('click', fetchMoreUploads);
  userButton?.addEventListener('click', fetchMoreUsers);
})();
