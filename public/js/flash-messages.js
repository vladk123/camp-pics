

let flashMessagesContainer = document.getElementById('flash-messages');

function createFlashMsg(type, message, dataAttrName, timeoutSec) {
  if (!type || !message || !dataAttrName) return;

  // Remove existing messages with same data name
  const existingMsg = document.querySelectorAll(`[data-flash-message="${dataAttrName}"]`);
  existingMsg.forEach(msg => msg.remove());

  const msgDiv = document.createElement('div');
  msgDiv.classList.add('alert', 'flash-message', type);
  msgDiv.setAttribute('data-flash-message', dataAttrName);

  // Message text span (so other elements like timer can sit beside)
  const msgText = document.createElement('span');
  msgText.textContent = message;

  // // Close button
  // const closeBtn = document.createElement('div');
  // closeBtn.textContent = '×';
  // closeBtn.classList.add('close-btn');
  // closeBtn.addEventListener('click', () => fadeOutAndRemove(msgDiv));

  msgDiv.append(msgText);

  // Countdown timer (if timeout provided)
  if (typeof timeoutSec === 'number' && timeoutSec > 0) {
    const timer = document.createElement('span');
    timer.classList.add('timer');
    timer.textContent = `${timeoutSec}`;
    // Click it to close
    timer.addEventListener('click', () => fadeOutAndRemove(msgDiv));
    msgDiv.append(timer);

    let remaining = timeoutSec;
    const interval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
      } else {
        timer.textContent = `${remaining}`;
      }
    }, 1000);

    // Auto close after timeout
    setTimeout(() => fadeOutAndRemove(msgDiv), timeoutSec * 1000);
  }

  // msgDiv.append(closeBtn);
  flashMessagesContainer.append(msgDiv);
}

// Helper: fade out before removing
function fadeOutAndRemove(element) {
  element.classList.add('fade-out');
  setTimeout(() => element.remove(), 500); // matches CSS transition time
}
