function sortMediaByDate(items) {
  return items.sort((a, b) => {
    const dateA = a.dateTaken ? new Date(a.dateTaken) : (a.uploadedAt ? new Date(a.uploadedAt) : new Date(0));
    const dateB = b.dateTaken ? new Date(b.dateTaken) : (b.uploadedAt ? new Date(b.uploadedAt) : new Date(0));
    return dateB - dateA; // newest first
  });
}

// Listen to campsite clicks
const parkCampsitesDiv = document.getElementById('park-campsites')
parkCampsitesDiv.addEventListener('click', async e => {
  const csEl = e.target.closest('.campsite');
  if (!csEl) return;

  const parkSlug = window.PARK.slug;
  const campsiteSlug = csEl.dataset.csSlug;
  const hasCg = csEl.dataset.hasCg === "true";
  const cgSlug = csEl.dataset.cgSlug || '';

  // Stash metadata for later submits/refreshes
  const modalParent = document.getElementById('campsite-modal-parent');
  modalParent.dataset.parkSlug = parkSlug;
  modalParent.dataset.campsiteSlug = campsiteSlug;
  modalParent.dataset.cgSlug = hasCg ? cgSlug : '';
  modalParent.dataset.hasCg = String(hasCg);

  // Build API URL
  let url;
  if (hasCg) {
    url = `/camp/park/${parkSlug}/campground/${cgSlug}/campsite/${campsiteSlug}`;
  } else {
    url = `/camp/park/${parkSlug}/campsite/${campsiteSlug}`;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    showCampsitePopup(data);
  } catch (err) {
    createFlashMsg('error', 'Could not load campsite details.', 'campsite-loading-error', 10)

  }
});


let campsiteSwiper = null;
let campsiteMediaItems = []; // keep around for delete / fullscreen if needed

function showCampsitePopup(data) {
  const modalParent = document.getElementById('campsite-modal-parent');
  
  // Scroll to top of modal in case lasdt time was scrolled down
  const campsiteModalWrapper = modalParent.querySelector('.campsite-modal-wrapper')
  const campsiteModalWrapperDiv = campsiteModalWrapper.querySelector('div')  
  campsiteModalWrapperDiv.scrollTop = 0

  // Try again just in case
  setTimeout(() => {
    campsiteModalWrapperDiv.scrollTop = 0
  }, 300);

  const modalDataset = 'campsite-modal';

  // Title
  const title = document.getElementById('campsite-modal-title');
  title.textContent = `Site #${data.siteNumber || ''}`;

  // DO NOT overwrite modalParent.dataset here.
  // It was set correctly in the click handler and is used by submitForm/refreshCampsitePopup.

  const swiperWrapper = document.getElementById('campsite-swiper-wrapper');
  const thumbsWrapper = document.getElementById('campsite-thumbs-wrapper');

  swiperWrapper.innerHTML = '';
  thumbsWrapper.innerHTML = '';

  // Merge + sort media
  const photos = data.photos || [];
  const videos = data.videos || [];

  campsiteMediaItems = [
    ...photos.map(p => ({
      type: 'photo',
      _id: p._id,
      user: p.user,
      url: p.url,
      caption: p.caption || '',
      username: p.username,
      dateTaken: p.dateTaken,
      uploadedAt: p.uploadedAt
    })),
    ...videos.map(v => ({
      type: 'video',
      _id: v._id,
      user: v.user,
      url: v.url,
      caption: v.caption || '',
      username: v.username,
      dateTaken: v.dateTaken,
      uploadedAt: v.uploadedAt
    }))
  ];

  campsiteMediaItems = sortMediaByDate(campsiteMediaItems);

  if (!campsiteMediaItems.length) {
    // Show "no media" slide
    const slide = document.createElement('div');
    slide.className = 'swiper-slide';
    slide.style.display = 'flex';
    slide.style.alignItems = 'center';
    slide.style.justifyContent = 'center';
    slide.innerHTML = window.CURRENT_USER_ID
      ? `No media uploaded for this campsite. Feel free to <a href="#modal-upload-section">contribute below.</a>`
      : 'No media uploaded for this campsite. Log in to contribute!';
    swiperWrapper.appendChild(slide);
  } else {
    campsiteMediaItems.forEach((item, index) => {
      // --- Main slide ---
      const slide = document.createElement('div');
      slide.className = 'swiper-slide';
      slide.dataset.index = String(index);

      const slideCaption = buildCampsiteCaption(item);

      if (item.type === 'photo') {
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = item.caption || `Photo ${index + 1}`;
        img.style.cursor = 'pointer';
        img.classList.add('photo')

        img.addEventListener('click', () => {
          openFullscreenImage(item.url, slideCaption);
        });

        const p = document.createElement('p');
        p.className = 'media-caption';
        p.textContent = slideCaption;

        // Add magnifying overlay
        const magnifying = document.createElement('img')
        magnifying.classList.add('magnifying')
        magnifying.src = '/images/icons/magnifying-glass.png'

        slide.appendChild(img);
        slide.appendChild(p);
        slide.appendChild(magnifying)
      } else {
        const vidId = extractYouTubeId(item.url);
        const iframe = document.createElement('iframe');
        iframe.src = `https://www.youtube.com/embed/${vidId}`;
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('allowfullscreen', 'true');

        const p = document.createElement('p');
        p.className = 'media-caption';
        p.textContent = slideCaption;

        slide.appendChild(iframe);
        slide.appendChild(p);

        // Optional: fullscreen click on caption
        p.style.cursor = 'pointer';
        p.addEventListener('click', () => {
          openFullscreenVideo(item.url, slideCaption);
        });
      }

      swiperWrapper.appendChild(slide);

      // --- Thumbnail ---
      const thumbWrapper = document.createElement('div');
      thumbWrapper.className = 'thumb-wrapper media-thumb-div';
      thumbWrapper.dataset.index = String(index);
      thumbWrapper.dataset.url = item.url;
      thumbWrapper.dataset.caption = slideCaption;
      thumbWrapper.dataset.id = item._id;
      thumbWrapper.dataset.type = item.type;

      const thumbImg = document.createElement('img');

      if (item.type === 'photo') {
        thumbImg.src = item.url;
        thumbImg.alt = item.caption || `Photo ${index + 1}`;
      } else {
        const vidId = extractYouTubeId(item.url);
        thumbImg.src = vidId
          ? `https://img.youtube.com/vi/${vidId}/hqdefault.jpg`
          : '/images/icons/video-placeholder.png';
        thumbImg.alt = item.caption || 'Video thumbnail';

        const playIcon = document.createElement('div');
        playIcon.className = 'video-play-overlay';
        thumbWrapper.appendChild(playIcon);
      }

      thumbImg.addEventListener('click', () => {
        if (campsiteSwiper) {
          campsiteSwiper.slideTo(index);
        }
        setActiveCampsiteThumb(index);
      });

      thumbWrapper.appendChild(thumbImg);

      // Delete button (owner or admin)
      if (window.CURRENT_USER_ID && (item.user === window.CURRENT_USER_ID || window.CURRENT_USER_IS_ADMIN === true)) {
        const delBtn = document.createElement('button');
        delBtn.className = 'media-thumb-delete' +
          (window.CURRENT_USER_IS_ADMIN === true && item.user !== window.CURRENT_USER_ID ? ' admin-delete' : '');
        delBtn.title = 'Delete';
        delBtn.textContent = '×';

        delBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!confirm('Delete this media?')) return;
          await deleteMedia(item, data);
        });

        thumbWrapper.appendChild(delBtn);
      }

      thumbsWrapper.appendChild(thumbWrapper);
    });
  }

  // Init / update Swiper
  if (campsiteSwiper) {
    campsiteSwiper.update();
    campsiteSwiper.slideTo(0);
    updateCampsiteArrowState(campsiteSwiper);

  } else {
    campsiteSwiper = new Swiper('.campsiteSwiper', {
      spaceBetween: 10,
      slidesPerView: 1,
      centeredSlides: true,
      navigation: {
        nextEl: '.campsite-swiper-next',
        prevEl: '.campsite-swiper-prev'
      },
      on: {
        slideChange(swiper) {
          // 1. Pause any YouTube videos on the OLD slide
          const prevSlide = swiper.slides[swiper.previousIndex];
          if (prevSlide) {
            const iframe = prevSlide.querySelector('iframe');
            if (iframe) {
              // Force-stop YouTube embed
              const src = iframe.src;
              iframe.src = src;
            }
          }

          // 2. Update active thumbnail
          setActiveCampsiteThumb(swiper.activeIndex);

          // 3. Update arrow states
          updateCampsiteArrowState(swiper);
        }
      }
    });
  }

  // Mark first thumb as active
  setActiveCampsiteThumb(0);
  updateCampsiteArrowState(campsiteSwiper);


  // Campsite thumbnail arrows: move Swiper, NOT scroll the thumbs
  const modal = document.getElementById('campsite-modal-parent');

  const leftBtn  = modal.querySelector('.campsite-thumb-left');
  const rightBtn = modal.querySelector('.campsite-thumb-right');

  leftBtn.onclick = () => {
    if (campsiteSwiper) campsiteSwiper.slidePrev();
  };

  rightBtn.onclick = () => {
    if (campsiteSwiper) campsiteSwiper.slideNext();
  };

  // Sync thumbs to swiper movement (like park slider)
  campsiteSwiper.on('slideChange', () => {
    const index = campsiteSwiper.activeIndex;
    setActiveCampsiteThumb(index);
  });


  // Open modal
  // Only create backdrop if not already open
  const existingBackdrop = document.querySelector(`.modal-backdrop[data-modal-id="${modalDataset}"]`);

  if (!existingBackdrop && modalParent.classList.contains('hidden')) {
    createModalBackdrop(modalDataset);
    listenModalBackdrops();
  }

  modalParent.classList.remove('hidden');
  modalParent.setAttribute('data-modal-id', modalDataset);


  // Update campsite badge count on open
  const total = (data.photos?.length || 0) + (data.videos?.length || 0);
  updateCampsiteBadge(data.slug || modalParent.dataset.campsiteSlug, total);
}

function updateCampsiteArrowState(swiper) {
  const modal = document.getElementById('campsite-modal-parent');
  const leftBtn  = modal.querySelector('.campsite-thumb-left');
  const rightBtn = modal.querySelector('.campsite-thumb-right');

  if (!leftBtn || !rightBtn) return;

  if (swiper.activeIndex === 0) {
    leftBtn.disabled = true;
  } else {
    leftBtn.disabled = false;
  }

  if (swiper.activeIndex === swiper.slides.length - 1) {
    rightBtn.disabled = true;
  } else {
    rightBtn.disabled = false;
  }
}


// Helper: caption text with date & username
function buildCampsiteCaption(item) {
  const parts = [];
  if (item.caption) parts.push(`"${item.caption}"`);
  if (item.dateTaken) parts.push(`${formatDate(item.dateTaken)}`);
  // if (item.uploadedAt) parts.push(`uploaded ${formatDate(item.uploadedAt)}`);
  if (item.username) parts.push(`by ${item.username}`);
  return parts.join(' • ');
}

// Helper: mark active thumb and scroll into view
function setActiveCampsiteThumb(index) {
  const allThumbs = document.querySelectorAll('#campsite-thumbs-wrapper .thumb-wrapper img');
  allThumbs.forEach((img, i) => {
    if (i === index) {
      img.classList.add('active');
      scrollCampsiteThumbIntoView(index);
    } else {
      img.classList.remove('active');
    }
  });
}

function scrollCampsiteThumbIntoView(index) {
  const wrapper = document.getElementById('campsite-thumbs-wrapper');
  const thumb = wrapper.querySelector(`.thumb-wrapper[data-index="${index}"]`);
  if (!thumb) return;

  thumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}



// Loads preview in the right-hand column
function loadCampsitePreview(item) {
    const previewWrapper = document.getElementById('campsite-preview-wrapper');
    const caption = document.getElementById('campsite-caption');

    previewWrapper.innerHTML = '';

    if (item.type === 'photo') {
        previewWrapper.innerHTML = `
            <img src="${item.url}" onclick="openFullscreenImage('${item.url}', '${item.caption || ''}')" />
        `;
    } else {
        const vidId = extractYouTubeId(item.url);
        previewWrapper.innerHTML = `
            <iframe src="https://www.youtube.com/embed/${vidId}" allowfullscreen></iframe>
        `;
    }

    caption.textContent =
        `${item.caption || ''}  
         ${item.username ? '• by ' + item.username : ''}  
         ${item.dateTaken ? '• taken ' + formatDate(item.dateTaken) : ''}`;
        

}



// Helper: extract video ID
function extractYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:.*v=|.*\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return match ? match[1] : null;
}


function isYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(url);
}


document.addEventListener('DOMContentLoaded', async() => {
  const parkSlug = window.PARK.slug;

  // Park-level forms
  const parkPhotoForm  = document.getElementById('park-photo-form');
  const parkVideoForm  = document.getElementById('park-video-form');
  const parkReviewForm = document.getElementById('park-review-form');

  if (parkPhotoForm) {
    parkPhotoForm.addEventListener('submit', e => {
      e.preventDefault();
      submitForm(parkPhotoForm, `/camp/park/${parkSlug}/photo`, { isFile: true, refresh: 'park' });
      // Push login event to Google Tag Manager (GTM)).
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'media_upload',
        media_type: 'photo',
        content_level: 'park',
        page_location: window.location.href 
      });
    });
  }
  if (parkVideoForm) {
    parkVideoForm.addEventListener('submit', e => {
      console.log(parkVideoForm)
      e.preventDefault();
      submitForm(parkVideoForm, `/camp/park/${parkSlug}/video`, { refresh: 'park' });
      // Push login event to Google Tag Manager (GTM)).
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'media_upload',
        media_type: 'video',
        content_level: 'park',
        page_location: window.location.href 
      });
    });
  }
  if (parkReviewForm) {
    parkReviewForm.addEventListener('submit', e => {
      e.preventDefault();
      submitForm(parkReviewForm, `/camp/park/${parkSlug}/review`, { refresh: 'park' });
    });
  }

  // Campsite popup forms 
  document.addEventListener('submit', e => {
    const form = e.target.closest('.campsite-photo-form, .campsite-video-form, .campsite-review-form');
    // console.log(form)
    if (!form) return;
    
    e.preventDefault();

    const popup = document.getElementById('campsite-modal-parent');
    const campsiteSlug = popup.dataset.campsiteSlug;
    const cgSlug = popup.dataset.cgSlug;
    const hasCg = popup.dataset.hasCg === 'true';

    let base = `/camp/park/${parkSlug}`;
    if (hasCg) base += `/campground/${cgSlug}`;
    base += `/campsite/${campsiteSlug}`;

    if (form.classList.contains('campsite-photo-form')) {
      submitForm(form, `${base}/photo`, { isFile: true, refresh: 'campsite' });
        // Push login event to Google Tag Manager (GTM)).
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
          event: 'media_upload',
          media_type: 'photo',
          content_level: 'campsite',
          page_location: window.location.href 
        });
    } else if (form.classList.contains('campsite-video-form')) {
      submitForm(form, `${base}/video`, { refresh: 'campsite' });
      // Push login event to Google Tag Manager (GTM)).
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'media_upload',
        media_type: 'video',
        content_level: 'campsite',
        page_location: window.location.href 
      });
    } else if (form.classList.contains('campsite-review-form')) {
      submitForm(form, `${base}/review`, { refresh: 'campsite' });
    }
  });

  
  // Load existing media on page load
  initializeParkSlider();
  await refreshParkMedia();

  // Set calendar max dates to not be past today
  const calendarFields = document.querySelectorAll('input[type="date"]');

  const formattedDate = new Date().toISOString().split('T')[0];
  calendarFields.forEach(field => {
    field.setAttribute('max', formattedDate);
  });
});



// Refresh the park-level media section
async function refreshParkMedia() {
  const parkSlug = window.PARK.slug;
  const res = await fetch(`/camp/park/${parkSlug}/media`);
  if (!res.ok) return console.error('Could not refresh park media');
  const { photos, videos } = await res.json();

  // const grid = document.getElementById('media-grid');
  // grid.innerHTML = '';
  // console.log(photos)
  // console.log(videos)

  // Combine videos + photos
  let mediaItems = [
    ...photos.map(p => ({
      type: 'photo',
      url: p.url,
      user: p.user,
      _id: p._id,
      caption: p.caption || '',
      username: p.username,
      dateTaken: p.dateTaken,
      uploadedAt: p.uploadedAt
    })),
    ...videos.map(v => ({
      type: 'video',
      url: v.url,
      user: v.user,
      _id: v._id,
      caption: v.caption || '',
      username: v.username,
      dateTaken: v.dateTaken,
      uploadedAt: v.uploadedAt
    }))
  ];

  // Sort by date
  mediaItems = sortMediaByDate(mediaItems);


  // If no media
  // if(!mediaItems.length){
  //   const mediaPreview = document.getElementById('media-preview')
  //   const text = document.createElement('p')
  //   if (window.CURRENT_USER_ID){
  //     text.textContent = 'No one has uploaded any photos or videos of the park yet - be the first!'
  //   } else {
  //     text.textContent = 'No one has uploaded any photos or videos of the park yet - be the first by logging in!'
  //   }
    
  //   mediaPreview?.after(text);
  // }

  const sliderSection = document.getElementById('park-media-slider');
  const noMediaEl = document.getElementById('no-park-media');
  noMediaEl.style.textAlign = 'center'

  // If no park media, don't show any slider stuff
  if (mediaItems.length === 0) {
    // Hide slider UI
    sliderSection.classList.add('hidden');

    // Show a message (optional)
    noMediaEl.innerHTML = window.CURRENT_USER_ID
      ? `No one has uploaded any photos or videos of the park yet — be the first <a href="#park-media">(bottom of the page)</a>!`
      : 'No one has uploaded any photos or videos of the park yet — log in to contribute!';

    noMediaEl.classList.add('general-max-width', 'margin-auto', 'p50', 'p0-top')

    return; // Stop here — don't call updateParkSlider()
  }

  sliderSection.classList.remove('hidden');
  noMediaEl.textContent = '';

  updateParkSlider(mediaItems);

}


// Refresh the currently open campsite popup
async function refreshCampsitePopup() {
  const popup = document.getElementById('campsite-modal-parent');
  const parkSlug = window.PARK.slug;
  const campsiteSlug = popup.dataset.campsiteSlug;
  const cgSlug = popup.dataset.cgSlug;
  const hasCg = popup.dataset.hasCg === 'true';

  let url;
  // console.log(hasCg)
  if (hasCg) {
    url = `/camp/park/${parkSlug}/campground/${cgSlug}/campsite/${campsiteSlug}`;
  } else {
    url = `/camp/park/${parkSlug}/campsite/${campsiteSlug}`;
  }

  const res = await fetch(url);
  if (!res.ok) return createFlashMsg('error', 'Could not refresh campsite - please refresh the page.', 'refresh-campsite-error', 15);
  const data = await res.json();

  // Re-render the popup
  showCampsitePopup(data);

  // Update the badge on the park page’s campsite button
  const total = (data.photos?.length || 0) + (data.videos?.length || 0);
  updateCampsiteBadge(campsiteSlug, total);
}

async function submitForm(form, endpoint, { isFile = false, refresh = 'none' } = {}) {
  const overlay = document.getElementById('main-loading-overlay');
  const btn = form.querySelector('button');
  const originalText = btn.textContent;

  btn.disabled = true;
  btn.textContent = 'Uploading...';
  overlay.classList.add('visible');

  const formData = new FormData(form);
  const fetchOpts = {
    method: 'POST',
    body: isFile ? formData : JSON.stringify(Object.fromEntries(formData)),
    headers: isFile ? {} : { 'Content-Type': 'application/json' },
  };

  try {
    if (form.id?.includes('video') && !isYouTubeUrl(formData.get('url'))) {
      throw new Error('Please enter a valid YouTube link.');
    }

    const res = await fetch(endpoint, fetchOpts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    // Refresh the appropriate UI
    if (refresh === 'park') {
      await refreshParkMedia();
    } else if (refresh === 'campsite') {
      await refreshCampsitePopup();
    }

    // If it's a park media upload, after upload, close modal and scroll user to top of page
    if (refresh === 'park') {
      // Close park media upload modal
      const modal = document.getElementById('park-media-upload-parent');
      modal?.classList.add('hidden');

      // Remove its backdrop
      const backdrop = document.querySelector('.modal-backdrop[data-modal-id="park-media-upload"]');
      backdrop?.remove();

      // Scroll main window to top AFTER modal closes
      setTimeout(() => {
        const slider = document.getElementById('park-media-slider');
        slider?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    }

    // If it's a campsite media upload, after upload, scroll user to top of modal
    if (refresh === 'campsite') {
      const modalParent = document.getElementById('campsite-modal-parent');
      const wrapper = modalParent?.querySelector('.campsite-modal-wrapper > div');

      if (wrapper) {
        wrapper.scrollTop = 0;

        // Safety re-run after DOM repaint
        setTimeout(() => {
          wrapper.scrollTop = 0;
        }, 100);
      }
    }

    // Clear inputs after success (photo/video forms)
    if (
      form.classList.contains('campsite-photo-form') ||
      form.classList.contains('campsite-video-form') ||
      form.id === 'park-photo-form' ||
      form.id === 'park-video-form'
    ) {
      form.reset();

      // Also clear any generated previews/captions (for photo uploads)
      const previewContainer = form.querySelector('#photo-preview-container');
      if (previewContainer) previewContainer.innerHTML = '';

      // Reset any counters if present
      const counter = form.querySelector('#photo-count');
      if (counter) counter.textContent = '0';
    }

    // Show message (if one was sent)
    const successMsg =
    data.message && typeof data.message === 'string'
      ? data.message
      : 'Uploaded!';
    createFlashMsg('success', successMsg, 'upload-media-success', 5);

  } catch (err) {
    console.error(err);
    createFlashMsg('error', `Error when uploading: ${err}. Please refresh and try again or contact us.`, 'upload-media-error', 15)
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
    overlay.classList.remove('visible');
  }
}

async function deleteMedia(item, parentData) {
  const parkSlug = window.PARK.slug;
  const campsiteSlug = parentData.slug;
  const cgSlug = parentData.cgSlug;
  const hasCg = !!cgSlug;
  let url;

  if (item.type === 'photo') {
    url = hasCg
      ? `/camp/park/${parkSlug}/campground/${cgSlug}/campsite/${campsiteSlug}/photo/${item._id}`
      : `/camp/park/${parkSlug}/campsite/${campsiteSlug}/photo/${item._id}`;
  } else {
    url = hasCg
      ? `/camp/park/${parkSlug}/campground/${cgSlug}/campsite/${campsiteSlug}/video/${item._id}`
      : `/camp/park/${parkSlug}/campsite/${campsiteSlug}/video/${item._id}`;
  }

  try {
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');

    // Push login event to Google Tag Manager (GTM)).
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'media_delete',
      media_type: item.type,
      content_level: campsiteSlug ? 'campsite' : 'park',
      page_location: window.location.href 
    });

    createFlashMsg('success', 'Deleted media!', 'delete-media-success', 5)
    await refreshCampsitePopup();
  } catch (err) {
    console.error(err);
    createFlashMsg('error', `Error deleting media: ${err}`, 'delete-media-error', 10)
  }
}


// GLOBAL FULLSCREEN MEDIA PREVIEW (images + YouTube videos)
document.addEventListener('click', e => {
  // Check for an image click
  const img = e.target.closest('.media-preview img, #media-grid img');
  const videoThumb = e.target.closest('.video-thumb img, .video-play-overlay');

  let overlayContent = '';
  // console.log(img)
  // console.log(videoThumb)

  if (videoThumb) {
    const videoWrapper = videoThumb.closest('.media-item, .media-thumb-div');
    if (!videoWrapper) return;
    const itemUrl = videoWrapper.dataset.url || '';
    const caption = videoWrapper.dataset.caption || '';
    const vidId = extractYouTubeId(itemUrl);
    if (!vidId) return;
    overlayContent = `
      <div class="overlay-media-wrapper">
        <iframe 
          src="https://www.youtube.com/embed/${vidId}" 
          frameborder="0" 
          allowfullscreen
          style="width:90vw;height:70vh;border-radius:8px;">
        </iframe>
        ${caption ? `<p class="overlay-caption">${caption}</p>` : ''}
      </div>`;
  } else if (img) {
    const parent = img.closest('.media-thumb-div, .media-item');
    const caption = parent?.dataset.caption || img.alt || '';
    overlayContent = `
      <div class="overlay-media-wrapper">
        <img src="${img.src}" style="">
        ${caption ? `<p class="overlay-caption">${caption}</p>` : ''}
      </div>`;
  }
  else {
    return; // Clicked neither image nor video
  }

  // Create overlay container
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.9)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '9999';
  overlay.style.cursor = 'zoom-out';
  overlay.innerHTML = overlayContent;

  // Push login event to Google Tag Manager (GTM)).
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: 'media_fullscreen_view',
    media_type: img ? 'photo' : 'video',
    content_level: 'campsite',
    page_location: window.location.href 
  });

  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
});

// UPDATE CAMPSITE BADGE (QUANTITY OF MEDIA) ON PARK PAGE, AFTER UPLOAD/DELETION
function updateCampsiteBadge(campsiteSlug, count) {
  // Use CSS.escape for safety with odd slugs; fallback if not available
  const esc = (str) => (window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/"/g, '\\"'));

  const li = document.querySelector(`.campsite[data-cs-slug="${esc(campsiteSlug)}"]`);
  if (!li) return;

  let badge = li.querySelector('.media-badge');

  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'media-badge';
      li.appendChild(badge);
    }
    badge.textContent = String(count);
    li.classList.add('has-media');
    li.classList.remove('no-media');
  } else {
    if (badge) badge.remove();
    li.classList.add('no-media');
    li.classList.remove('has-media');
  }
}

// If user reports 
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.report-btn');
  if (!btn) return;
  reportBtn(e);
});

function reportBtn(e) {
  let park, campground, campsite;

  // Campsite modal case
  const campsiteModal = e.target.closest('#campsite-modal-parent');
  if (campsiteModal) {
    park = campsiteModal.dataset.parkSlug;
    campground = campsiteModal.dataset.cgSlug;
    campsite = campsiteModal.dataset.campsiteSlug;
  }

  // Push login event to Google Tag Manager (GTM)).
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: 'press_report_btn',
    content_level: campsite ? 'campsite': 'park',
    campsite,
    page_location: window.location.href 
  });

  window.open(
    `/other/contact?email_subject=Report Image: ${park ? `[${park}]` : `${window.PARK.slug}`}${campground ? `[${campground}]` : ''}${campsite ? `[${campsite}]` : ''}`,
    '_blank'
  ).focus();
}


window.openFullscreenImage = function(src, caption = '') {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.9)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '9999';
  overlay.style.cursor = 'zoom-out';

  overlay.innerHTML = `
    <div class="overlay-media-wrapper">
      <img src="${src}" style="max-width:90vw;max-height:80vh;border-radius:8px;">
      ${caption ? `<p class="overlay-caption">${caption}</p>` : ''}
    </div>
  `;

  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
};

window.openFullscreenVideo = function(url, caption = '') {
  const vidId = extractYouTubeId(url);
  if (!vidId) return;

  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.9)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '9999';
  overlay.style.cursor = 'zoom-out';

  overlay.innerHTML = `
    <div class="overlay-media-wrapper">
      <iframe 
        src="https://www.youtube.com/embed/${vidId}"
        frameborder="0"
        allowfullscreen
        style="width:90vw;height:70vh;border-radius:8px;">
      </iframe>
      ${caption ? `<p class="overlay-caption">${caption}</p>` : ''}
    </div>
  `;

  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
};

// When user clicks on btn to open modal to upload park media
const openUploadParkMediaModalBtn = document.getElementById('open-upload-park-media-modal')
const parkMediaUploadParent = document.getElementById('park-media-upload-parent')
openUploadParkMediaModalBtn?.addEventListener('click', () => {
  const modalDataset = 'park-media-upload';

  // Only guard against existing BACKDROP (not the modal element)
  const backdropExists = document.querySelector(`.modal-backdrop[data-modal-id="${modalDataset}"]`);
  // Or, additionally: if the modal is currently visible, skip
  const modalIsVisible = !parkMediaUploadParent.classList.contains('hidden');

  if (backdropExists || modalIsVisible) {
    // Already open or has a live backdrop
    return;
  }

  createModalBackdrop(modalDataset);
  listenModalBackdrops();

  parkMediaUploadParent.classList.remove('hidden');
  parkMediaUploadParent.setAttribute('data-modal-id', modalDataset); // explicit
})

// Campsite modal closing logic
document.addEventListener('click', e => {
  if (!e.target.closest('#close-campsite-modal')) return;

  const modal = document.getElementById('campsite-modal-parent');

  // Clear iframe content to stop video sound
  const iframes = modal.querySelectorAll('iframe');
  iframes.forEach(f => {
    f.src = f.src; // reloads/clears YouTube embedding
  });

  // Clear swiper + thumbs
  document.getElementById('campsite-swiper-wrapper').innerHTML = '';
  document.getElementById('campsite-thumbs-wrapper').innerHTML = '';

  modal.classList.add('hidden');

  // Remove backdrop
  const backdrop = document.querySelector('.modal-backdrop[data-modal-id="campsite-modal"]');
  if (backdrop) backdrop.remove();
});


// Funcs to analyze img to find low-res or extreme aspect ratio images to alter how they're shown on swiper
async function analyzeParkImages() {
  const slides = document.querySelectorAll('#park-swiper-wrapper .swiper-slide img');

  slides.forEach(img => {
    // Ensure image is fully loaded before analyzing
    if (!img.complete) {
      img.onload = () => analyzeSingleImage(img);
    } else {
      analyzeSingleImage(img);
    }
  });
}

function analyzeSingleImage(img) {
  // If it's an icon
  if(img.classList.contains('magnifying')) return

  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  if (!naturalW || !naturalH) return;

  // ---- RULES ----
  const TOTAL_PIXELS = naturalW * naturalH;

  const isLowPixelCount   = TOTAL_PIXELS < 1_000_000; // <1 megapixel
  const isSmallDimension  = naturalW < 1000 || naturalH < 600;
  const ratio             = naturalW / naturalH;
  const isPanorama        = ratio > 5.0;
  const isTallVertical    = ratio < 1/5;

  const shouldFlag =
    isLowPixelCount ||
    isSmallDimension ||
    isPanorama ||
    isTallVertical;

  if (shouldFlag) {
    img.classList.add('low-resolution');
    img.closest('.swiper-slide')?.classList.add('low-resolution');
  }
}

// Limit user on how many files to upload
document.addEventListener('change', e => {

  const input = e.target;
  if (input.type !== 'file') return;
  let limit = 5;
  if (input.closest('#park-photo-form')) limit = 2;

  if (input.files.length > limit) {
    createFlashMsg('error', `Maximum ${limit} total allowed.`, 'campsite-loading-error', 10)
    input.value = '';
  } 
});

