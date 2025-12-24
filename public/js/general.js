////// GA4 Google Analytics - Any redirectedFlash data to push through Tag Manager when page loads
// window.__GA4_EVENT from boilerplate file
if (window.__GA4_EVENT__) {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: window.__GA4_EVENT__.event,
    user_id: window.__GA4_EVENT__.user_id,
    page_location: window.location.href
  });

  // Safety: prevent accidental reuse
  window.__GA4_EVENT__ = null;
}


////// SOCIAL MEDIA
const isProbablyMobile =
  window.matchMedia('(pointer: coarse)').matches &&
  window.matchMedia('(hover: none)').matches;

const shareBtn = document.getElementById('share-btn');
// console.log(shareBtn)
const shareData = {
  title: document.title,
  text: window.PARK
    ? `See and share photos of campsites in ${window.PARK.name}`
    : `See and share photos of Canadian campsites.`,
  url: window.location.href
};

if (!isProbablyMobile) {
  shareBtn?.classList.remove('visible');
}

if (navigator.share && navigator.canShare?.(shareData)) {
  shareBtn?.addEventListener('click', async () => {
    try {
      console.log('doing nav.share');
      await navigator.share(shareData);
    } catch (err) {
      console.log('Share cancelled or failed');
    }
  });
} else {
  shareBtn?.classList.remove('visible');
}

////// DARK MODE
const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

function getInitialTheme() {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;

  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

const darkModeToggleBtn = document.getElementById('themeToggle');

darkModeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';

  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  // Push event to Google Tag Manager (GTM)).
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    event: 'theme_change',
    change_to: next,
    page_location: window.location.href 
  });
});

// Respond to any changes in user's theme
const userMediaThemeSettings = window.matchMedia('(prefers-color-scheme: dark)');
userMediaThemeSettings.addEventListener('change', e => {
  if (localStorage.getItem('theme')) return;

  document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
});

// Notify user if is using a dark reader extension (it'll look bad)
document.addEventListener("DOMContentLoaded", () => {
  (function isDarkReaderEnabled() {
    const metaElement = document.querySelector('head meta[name="darkreader"]');
    const darkReaderMsgShown = localStorage.getItem('darkReaderMsgShown');
    // console.log(darkReaderMsgShown)
    if(!darkReaderMsgShown){
      localStorage.setItem('darkReaderMsgShown', true);
    }
    if(metaElement && !darkReaderMsgShown){
      createFlashMsg('info', 'You may have a dark reader extension in your browser - we suggest disabling that to avoid this website from looking unusual.', 'dark-reader-msg', 120);
    }
  })()
})

////// MODALS
const modalCloseBtns = document.querySelectorAll('.modal-close')
const modalBackdropInsertPoint = document.getElementById('modal-backdrop-insert')

// Closing functionality
// Find all close buttons in modal contents
modalCloseBtns.forEach(btn => {
  btn.addEventListener('click', (event) => {
    const clicked = event.target;
    const parentEl = clicked.parentElement.parentElement.parentElement.parentElement.parentElement; // your modal root
    if(parentEl.classList.contains('modal-parent')){
      parentEl.classList.add('hidden');

      // Get modal dataset to find matching backdrop
      const modalDataset = parentEl.dataset.modalId;

      // Unset on the modal itself
      if (parentEl.hasAttribute('data-modal-id')) {
        parentEl.removeAttribute('data-modal-id');
      }

      if (modalDataset) {
        const modalBackdrop = modalBackdropInsertPoint.querySelector(`.modal-backdrop[data-modal-id="${modalDataset}"]`);
        // Unset on the backdrop, then remove it
        if (modalBackdrop) {
          modalBackdrop.removeAttribute('data-modal-id');
          modalBackdrop.remove();
        }
      }
    }

  });
});


// Function to listen to any new backdrops and their mouse clicks to close modal
function listenModalBackdrops () {
  const modalBackdrops = document.querySelectorAll('#modal-backdrop-insert > .modal-backdrop');
  modalBackdrops.forEach(backdrop => {
    backdrop.addEventListener('click', (event) => {
      const clicked = event.target;
      // Read the id before removal
      const modalDataset = clicked.getAttribute('data-modal-id');

      // Remove backdrop
      clicked.remove();

      if (modalDataset) {
        const modal = document.querySelector(`[data-modal-id="${modalDataset}"]`);
        if (modal) {
          modal.classList.add('hidden');
          // Unset on the modal
          modal.removeAttribute('data-modal-id');
        }

        // Stop any campsite videos playing, if any
        if (modal) {
          // STOP VIDEO (important)
          modal.querySelectorAll('iframe').forEach(f => f.src = f.src);

          // RESET SLIDER CONTENT
          const sw = modal.querySelector('#campsite-swiper-wrapper');
          const th = modal.querySelector('#campsite-thumbs-wrapper');
          if (sw) sw.innerHTML = '';
          if (th) th.innerHTML = '';

          modal.classList.add('hidden');
          modal.removeAttribute('data-modal-id');
        }
      }



    });
  });
}



// Create a modal backdrop function
function createModalBackdrop (modalId) {
    // Generate the modal backdrop
    const modalBackdropDiv = document.createElement('div')
    modalBackdropDiv.classList.add('modal-backdrop')
    modalBackdropDiv.dataset.modalId = modalId

    // Insert it into the body insert point
    modalBackdropInsertPoint.appendChild(modalBackdropDiv)
}

////// SCROLL TO TOP
// Scroll to top btn
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("scroll-to-top-btn");

  function toggleScrollBtn() {
    if (window.scrollY > 300) {
      btn.classList.add("visible");
    } else {
      btn.classList.remove("visible");
    }
  }

  window.addEventListener("scroll", toggleScrollBtn);

  btn.addEventListener("click", () => {
    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  });
});


////// SEARCH
// Reset search when reset clicked
const clearSearchBtn = document.getElementById('clear-search')
const searchInputBox = document.getElementById('search-input-box')
// clearSearchBtn?.addEventListener('click', ()=>{
//   clearSearchBox()
//   searchInputBox.focus()
// })
// Reusable func to reset search box
function clearSearchBox () {
    searchInputBox.value=''
}

////// RESET WIDTH + NAVBAR LOGIC
document.addEventListener('DOMContentLoaded', () => {
 
  // Change background img based on time of year
  (function changeBackgroundImg() {
    const currentDate = new Date();
    const currentMonthNumber = currentDate.getMonth()+1;

    const homeHero = document.getElementById('home-hero')
    const homeNav = document.getElementById('navbar')
    const homeNavBg = homeNav.querySelector('.background')
    const homeNavExists = homeNav.classList.contains('home') // Make sure it's on the home page

    // Set home page hero OR navbar (if not on home page)
    // If winter
    if(currentMonthNumber >= 11 || currentMonthNumber < 3){
      if(homeHero) {homeHero.style.backgroundImage = "url('/images/images/home-hero-winter.jpg')"}
      // if(!homeNavExists) {homeNavBg.style.backgroundImage = "url('/images/images/home-hero-winter.jpg')"}
      if(!homeNavExists) {homeNavBg.style.backgroundColor = "var(--winter-color)"}
    // If fall
    } else if(currentMonthNumber >= 9){
      if(homeHero) {homeHero.style.backgroundImage = "url('/images/images/home-hero-autumn.jpg')"}
      // if(!homeNavExists) {homeNavBg.style.backgroundImage = "url('/images/images/home-hero-autumn.jpg')"}
      if(!homeNavExists) {homeNavBg.style.backgroundColor = "var(--autumn-color)"}
    // If summer
    } else if(currentMonthNumber >= 6){
      if(homeHero) {homeHero.style.backgroundImage = "url('/images/images/home-hero-summer.jpg')"}
      // if(!homeNavExists) {homeNavBg.style.backgroundImage = "url('/images/images/home-hero-summer.jpg')"}
      if(!homeNavExists) {homeNavBg.style.backgroundColor = "var(--summer-color)"}
    // If spring
    } else if(currentMonthNumber >= 3){
      if(homeHero) {homeHero.style.backgroundImage = "url('/images/images/home-hero-spring.jpg')"}
      // if(!homeNavExists) {homeNavBg.style.backgroundImage = "url('/images/images/home-hero-spring.jpg')"}
      if(!homeNavExists) {homeNavBg.style.backgroundColor = "var(--spring-color)"}

    } 
  })();

  // Navbar logic
  const toggle = document.getElementById('nav-mobile-toggle');
  const navLinks = document.getElementById('nav-links');
  const closeBtn = document.getElementById('nav-close-btn');
  const backdrop = document.getElementById('nav-backdrop');

  if (!toggle || !navLinks) return;

  function openMenu() {
    navLinks.classList.add('open');
    backdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    navLinks.classList.remove('open');
    backdrop.classList.remove('visible');
    document.body.style.overflow = '';
  }

  toggle.addEventListener('click', openMenu);
  closeBtn.addEventListener('click', closeMenu);
  backdrop.addEventListener('click', closeMenu);

  // When mobile menu open but making the screen bigger, need to close mobile menu
  let lastWidth = window.innerWidth;

  window.addEventListener('resize', () => {
    const w = window.innerWidth;

    // Resize crossed FROM mobile TO desktop
    if (lastWidth < 769 && w >= 769) {
      closeMenu();  // force-close mobile menu
    }

    lastWidth = w;
  });
})

////// RANDOM FUNCS
// Function to make string URL-friendly
function toSlug (name){
    return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()                  // lowercase
    .trim()                         // remove leading/trailing spaces
    .replace(/[\s_]+/g, '-')        // replace spaces/underscores with hyphens
    .replace(/[^\w\-]+/g, '')       // remove all non-word chars except hyphen
    .replace(/\-\-+/g, '-')        // collapse multiple hyphens
    .replace(/^-+|-+$/g, ''); 
}


// Make date look nicer, and not account for user timezone
function formatDate(date) {
  if (!date) return '';

  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  return `${months[m - 1]} ${d}, ${y}`;
}

