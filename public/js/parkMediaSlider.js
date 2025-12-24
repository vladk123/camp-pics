window.initializeParkSlider = initializeParkSlider;
window.updateParkSlider = updateParkSlider;
window.buildMediaHTML = buildMediaHTML;

function buildMediaHTML(mediaItems) {
  const slidesHTML = [];
  const thumbsHTML = [];

  mediaItems.forEach((item, i) => {
    let slide;
    let thumb;

    if (item.type === 'photo') {
      slide = `
        <div 
            class="swiper-slide" 
            data-id="${item._id}" 
            data-type="photo" 
            data-url="${item.url}">
            <img class="photo" src="${item.url}">
            <div class="caption" style="display:none;">
                ${item.caption || ''}
                ${item.dateTaken ? ` (${formatDate(item.dateTaken)})` : ''}
                ${item.username ? ` - ${item.username}` : ''}
            </div>
            <img class="magnifying" src="/images/icons/magnifying-glass.png">

        </div>
      `;
      thumb = `
        <div class="thumb-wrapper" 
            data-id="${item._id}"
            data-type="${item.type}"
            data-url="${item.url}">
            
            ${window.CURRENT_USER_ID && (item.user === window.CURRENT_USER_ID || window.CURRENT_USER_IS_ADMIN)
            ? `<button class="media-thumb-delete ${window.CURRENT_USER_IS_ADMIN && item.user !== window.CURRENT_USER_ID ? 'admin-delete' : ''}"
                        data-id="${item._id}"
                        data-type="${item.type}">×</button>`
            : ''
            }

            <img src="${item.url}" data-index="${i}" class="thumb">
        </div>`;

    } else {
      const vidId = extractYouTubeId(item.url);
      const thumbUrl = vidId
        ? `https://img.youtube.com/vi/${vidId}/hqdefault.jpg`
        : '/images/icons/video-placeholder.png';

      slide = `
        <div 
            class="swiper-slide" 
            data-id="${item._id}" 
            data-type="video" 
            data-url="${item.url}">
            <iframe src="https://www.youtube.com/embed/${vidId}" allowfullscreen></iframe>
            <div class="caption">
                ${item.caption || ''}
                ${item.dateTaken ? ` (${formatDate(item.dateTaken)})` : ''}
                ${item.username ? ` - ${item.username}` : ''}
            </div>

        </div>
      `;
      thumb = `
        <div class="thumb-wrapper" 
            data-id="${item._id}"
            data-type="${item.type}"
            data-url="${item.url}">
            
            ${window.CURRENT_USER_ID && (item.user === window.CURRENT_USER_ID || window.CURRENT_USER_IS_ADMIN)
            ? `<button 
                class="media-thumb-delete ${window.CURRENT_USER_IS_ADMIN && item.user !== window.CURRENT_USER_ID ? 'admin-delete' : ''}"
                data-id="${item._id}"
                data-type="${item.type}">×</button>`
            : ''
            }

            <img src="${thumbUrl}" data-index="${i}" class="thumb">
            <div class="video-play-overlay"></div>
        </div>`;

    }

    slidesHTML.push(slide);
    thumbsHTML.push(thumb);
  });

  return { slidesHTML, thumbsHTML };
}


let parkSwiper;
function initializeParkSlider() {
    parkSwiper = new Swiper(".parkSwiper", {
    slidesPerView: 1,
    spaceBetween: 0,
    navigation: {
        nextEl: ".swiper-button-next",
        prevEl: ".swiper-button-prev",
    },
    allowTouchMove: true,
    effect: "slide",

    on: {
        slideChange(swiper) {
        // Pause any YouTube iframes that were on the OLD slide
        const prevSlide = swiper.slides[swiper.previousIndex];
        if (prevSlide) {
            const iframe = prevSlide.querySelector("iframe");
            if (iframe) {
            const src = iframe.src;
            iframe.src = src; // reloads iframe → stops YouTube video
            }
        }
        }
    }
    });


  // Clicking on a slide → full screen (reuse your existing overlay logic)
  document.querySelector(".parkSwiper").addEventListener("click", e => {
    const slide = e.target.closest(".swiper-slide");
    if (!slide) return;

    if (parkSwiper.autoplay.running) {
        parkSwiper.autoplay.stop();
    }

    if (slide.dataset.type === "photo") {
        openFullscreenImage(slide.dataset.url, slide.querySelector(".caption")?.innerText);
    } else {
        // Pause YouTube in the background slide (if any)
        const iframe = slide.querySelector("iframe");
        if (iframe) iframe.src = iframe.src;
        openFullscreenVideo(slide.dataset.url, slide.querySelector(".caption")?.innerText);
    }
    // Push event to Google Tag Manager (GTM)).
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'media_fullscreen_view',
      media_type: slide.dataset.type,
      content_level: 'park',
      page_location: window.location.href 
    });
  });
}

function updateParkSlider(mediaItems) {
    const { slidesHTML, thumbsHTML } = buildMediaHTML(mediaItems);

    document.getElementById("park-swiper-wrapper").innerHTML = slidesHTML.join("");
    document.getElementById("park-thumbs-wrapper").innerHTML = thumbsHTML.join("");

    // update Swiper
    parkSwiper.update();

    analyzeParkImages();

    // click → change slide
    document.querySelectorAll("#park-thumbs-wrapper img").forEach(thumb => {
        thumb.addEventListener("click", () => {
            const index = Number(thumb.dataset.index);
            parkSwiper.slideTo(index);

            if (parkSwiper.autoplay.running) {
                parkSwiper.autoplay.stop();
            }

            setActiveThumb(index);
        });
    });

    // sync when sliding via arrows or swipe
    parkSwiper.on("slideChange", () => {
        const index = parkSwiper.activeIndex;
        setActiveThumb(index);
        scrollThumbIntoView(index);
    });

    setActiveThumb(0);

    document.querySelectorAll('.thumb-wrapper .media-thumb-delete').forEach(btn => {
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const type = btn.dataset.type;

            if (!confirm('Delete this media?')) return;

            let url;
            if (type === "photo") {
                url = `/camp/park/${window.PARK.slug}/photo/${id}`;
            } else {
                url = `/camp/park/${window.PARK.slug}/video/${id}`;
            }

            try {
                const res = await fetch(url, { method: "DELETE" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Delete failed');
                // Push event to Google Tag Manager (GTM)).
                window.dataLayer = window.dataLayer || [];
                window.dataLayer.push({
                    event: 'media_delete',
                    media_type: type,
                    content_level: 'park',
                    page_location: window.location.href 
                });

                createFlashMsg('success', 'Deleted successfully.', 'delete-media-success', 5);
                await refreshParkMedia();
            } catch (err) {
                createFlashMsg('error', 'Error deleting.', 'delete-media-error', 10);
            }
        });
    });

    // Thumbnail scroll behaviour
    const slider = document.getElementById("park-media-slider");

    const leftBtn = slider.querySelector(".thumb-nav.left");
    const rightBtn = slider.querySelector(".thumb-nav.right");
    const wrapper = slider.querySelector("#park-thumbs-wrapper");


    leftBtn.onclick = () => {
        parkSwiper.slidePrev();
        if (parkSwiper.autoplay.running) {
            parkSwiper.autoplay.stop();
        }
    };

    rightBtn.onclick = () => {
        parkSwiper.slideNext();
        if (parkSwiper.autoplay.running) {
            parkSwiper.autoplay.stop();
        }
    };

    // Auto enable/disable thumbnail arrow btns
    function updateNavButtonState() {
    if (parkSwiper.activeIndex === 0) {
        leftBtn.disabled = true;
    } else {
        leftBtn.disabled = false;
    }

    if (parkSwiper.activeIndex === parkSwiper.slides.length - 1) {
        rightBtn.disabled = true;
    } else {
        rightBtn.disabled = false;
    }
    }

    parkSwiper.on('slideChange', updateNavButtonState);
    updateNavButtonState();


}

function setActiveThumb(i) {
//   document.querySelectorAll("#park-thumbs-wrapper img").forEach((t, idx) => {
//     t.classList.toggle("active", idx === i);
//   });

    const slider = document.getElementById("park-media-slider");

    slider.querySelectorAll("#park-thumbs-wrapper img").forEach((t, idx) => {
        t.classList.toggle("active", idx === i);
    });

}


function scrollThumbIntoView(index) {
    // const wrapper = document.getElementById("park-thumbs-wrapper");
    // const thumb = wrapper.querySelector(`.thumb-wrapper:nth-child(${index + 1})`);
    
    const slider = document.getElementById("park-media-slider");
    const wrapper = slider.querySelector("#park-thumbs-wrapper");
    const thumb = wrapper.querySelector(`.thumb-wrapper:nth-child(${index + 1})`);


    if (!thumb) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();

    // If thumb is left of visible area
    if (thumbRect.left < wrapperRect.left) {
        wrapper.scrollBy({
        left: thumbRect.left - wrapperRect.left - 20,
        behavior: "smooth"
        });
    }

    // If thumb is right of visible area
    else if (thumbRect.right > wrapperRect.right) {
        wrapper.scrollBy({
        left: thumbRect.right - wrapperRect.right + 20,
        behavior: "smooth"
        });
    }

    thumb.addEventListener("click", () => {
        const index = Number(thumb.querySelector("img").dataset.index);
        parkSwiper.slideTo(index);

        if (parkSwiper.autoplay.running) {
            parkSwiper.autoplay.stop();
        }

        setActiveThumb(index);
        scrollThumbIntoView(index); 
    });

}
