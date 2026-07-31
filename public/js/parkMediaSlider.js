window.initializeParkSlider = initializeParkSlider;
window.updateParkSlider = updateParkSlider;
window.buildMediaHTML = buildMediaHTML;

const parkMediaRendering = window.CampPicsMedia;
const parkDeletionResponse = window.CampPicsMediaDeletionResponse;
const parkSlideMedia = new WeakMap();

function buildParkCaption(item) {
  return `${item.caption || ''}` +
    `${item.dateTaken ? ` (${formatDate(item.dateTaken)})` : ''}` +
    `${item.username ? ` - ${item.username}` : ''}`;
}

function buildMediaHTML(mediaItems) {
  const slidesHTML = [];
  const thumbsHTML = [];

  mediaItems.forEach((item, index) => {
    const slide = document.createElement('div');
    slide.className = 'swiper-slide';
    slide.dataset.id = item._id == null ? '' : String(item._id);
    slide.dataset.type = item.type;
    parkSlideMedia.set(slide, item);

    const captionText = buildParkCaption(item);
    const caption = parkMediaRendering.createCaptionElement({
      className: 'caption',
      text: captionText,
      hidden: item.type === 'photo',
    });

    if (item.type === 'photo') {
      const image = parkMediaRendering.createImageElement({
        src: item.url,
        alt: item.caption || `Photo ${index + 1}`,
        className: 'photo',
      });
      const magnifying = parkMediaRendering.createImageElement({
        src: '/images/icons/magnifying-glass.png',
        alt: '',
        className: 'magnifying',
        fallbackSrc: '',
      });
      slide.append(image, caption, magnifying);
    } else {
      const video = parkMediaRendering.createYouTubeIframe(item.url, {
        title: item.caption || `YouTube video ${index + 1}`,
      });
      const media = video || parkMediaRendering.createImageElement({
        src: parkMediaRendering.VIDEO_PLACEHOLDER,
        alt: 'Video unavailable',
        className: 'video-placeholder',
        fallbackSrc: '',
      });
      slide.append(media, caption);
    }

    const canDelete = Boolean(
      window.CURRENT_USER_ID &&
      (item.user === window.CURRENT_USER_ID || window.CURRENT_USER_IS_ADMIN)
    );
    const thumb = parkMediaRendering.createMediaThumbnail({
      item,
      index,
      caption: captionText,
      imageClassName: 'thumb',
      canDelete,
      isAdminDelete: Boolean(
        window.CURRENT_USER_IS_ADMIN &&
        item.user !== window.CURRENT_USER_ID
      ),
      onActivate: selectedIndex => {
        parkSwiper.slideTo(selectedIndex);
        stopParkAutoplay();
        setActiveThumb(selectedIndex);
      },
      onDelete: deleteParkMedia,
    });

    slidesHTML.push(slide);
    thumbsHTML.push(thumb);
  });

  return { slidesHTML, thumbsHTML };
}

let parkSwiper;

function initializeParkSlider() {
  parkSwiper = new Swiper('.parkSwiper', {
    slidesPerView: 1,
    spaceBetween: 0,
    navigation: {
      nextEl: '.swiper-button-next',
      prevEl: '.swiper-button-prev',
    },
    allowTouchMove: true,
    effect: 'slide',
    on: {
      slideChange(swiper) {
        const prevSlide = swiper.slides[swiper.previousIndex];
        if (prevSlide) {
          const iframe = prevSlide.querySelector('iframe');
          if (iframe) {
            const src = iframe.src;
            iframe.src = src;
          }
        }

        setActiveThumb(swiper.activeIndex);
        scrollThumbIntoView(swiper.activeIndex);
        updateParkNavButtonState();
      },
    },
  });

  document.querySelector('.parkSwiper').addEventListener('click', event => {
    const slide = event.target.closest('.swiper-slide');
    if (!slide) return;

    const item = parkSlideMedia.get(slide);
    if (!item) return;

    stopParkAutoplay();

    const caption = slide.querySelector('.caption')?.textContent || '';
    if (item.type === 'photo') {
      openFullscreenImage(item.url, caption);
    } else {
      const iframe = slide.querySelector('iframe');
      if (iframe) iframe.src = iframe.src;
      openFullscreenVideo(item.url, caption);
    }

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'media_fullscreen_view',
      media_type: item.type,
      content_level: 'park',
      page_location: window.location.href,
    });
  });

  const slider = document.getElementById('park-media-slider');
  slider.querySelector('.thumb-nav.left').addEventListener('click', () => {
    parkSwiper.slidePrev();
    stopParkAutoplay();
  });
  slider.querySelector('.thumb-nav.right').addEventListener('click', () => {
    parkSwiper.slideNext();
    stopParkAutoplay();
  });
}

function updateParkSlider(mediaItems) {
  const { slidesHTML, thumbsHTML } = buildMediaHTML(mediaItems);

  document.getElementById('park-swiper-wrapper').replaceChildren(...slidesHTML);
  document.getElementById('park-thumbs-wrapper').replaceChildren(...thumbsHTML);

  parkSwiper.update();
  analyzeParkImages();
  setActiveThumb(0);
  updateParkNavButtonState();
}

async function deleteParkMedia(item) {
  if (!confirm('Delete this media?')) return;

  const url = item.type === 'photo'
    ? `/camp/park/${window.PARK.slug}/photo/${item._id}`
    : `/camp/park/${window.PARK.slug}/video/${item._id}`;

  try {
    const response = await window.CampPicsCsrf.fetch(url, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' },
    });
    const data = await response.json();
    const outcome = parkDeletionResponse.classify(
      response,
      data,
      'Deleted successfully.',
    );
    if (!outcome.success) {
      throw new Error(
        window.CampPicsCsrf.responseErrorMessage(response, data, 'Delete failed.'),
      );
    }

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'media_delete',
      media_type: item.type,
      content_level: 'park',
      page_location: window.location.href,
    });

    createFlashMsg(
      'success',
      outcome.message,
      'delete-media-success',
      5,
    );
    await refreshParkMedia();
  } catch (error) {
    createFlashMsg('error', error.message || 'Error deleting.', 'delete-media-error', 10);
  }
}

function stopParkAutoplay() {
  if (parkSwiper?.autoplay?.running) parkSwiper.autoplay.stop();
}

function updateParkNavButtonState() {
  const slider = document.getElementById('park-media-slider');
  const leftBtn = slider.querySelector('.thumb-nav.left');
  const rightBtn = slider.querySelector('.thumb-nav.right');

  leftBtn.disabled = parkSwiper.activeIndex === 0;
  rightBtn.disabled = parkSwiper.activeIndex === parkSwiper.slides.length - 1;
}

function setActiveThumb(index) {
  const slider = document.getElementById('park-media-slider');

  slider.querySelectorAll('#park-thumbs-wrapper img').forEach((thumb, thumbIndex) => {
    thumb.classList.toggle('active', thumbIndex === index);
  });
}

function scrollThumbIntoView(index) {
  const slider = document.getElementById('park-media-slider');
  const wrapper = slider.querySelector('#park-thumbs-wrapper');
  const thumb = wrapper.querySelector(`.thumb-wrapper:nth-child(${index + 1})`);
  if (!thumb) return;

  const wrapperRect = wrapper.getBoundingClientRect();
  const thumbRect = thumb.getBoundingClientRect();

  if (thumbRect.left < wrapperRect.left) {
    wrapper.scrollBy({
      left: thumbRect.left - wrapperRect.left - 20,
      behavior: 'smooth',
    });
  } else if (thumbRect.right > wrapperRect.right) {
    wrapper.scrollBy({
      left: thumbRect.right - wrapperRect.right + 20,
      behavior: 'smooth',
    });
  }
}
