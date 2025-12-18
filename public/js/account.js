const deleteBtn = document.getElementById('delete-account-btn');
const modal1 = document.getElementById('delete-account-modal');
const modal2 = document.getElementById('delete-account-modal-2');
const confirmStep1 = document.getElementById('confirm-step1');
const deleteAccountModalBackdropInsertPoint = document.getElementById('delete-account-modal-backdrop-insert');

// helper: open modal
function openModal(modalEl) {
  modalEl.classList.remove('hidden');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.dataset.modalId = modalEl.dataset.modalId;
  deleteAccountModalBackdropInsertPoint.appendChild(backdrop);
  backdrop.addEventListener('click', () => {
    closeModal(modalEl)
  });
}

// helper: close modal
function closeModal(modalEl) {
  modalEl.classList.add('hidden');
  const id = modalEl.dataset.modalId;
  const backdrop = deleteAccountModalBackdropInsertPoint.querySelector(`.modal-backdrop[data-modal-id="${id}"]`);
  if (backdrop) backdrop.remove();
}

// open first confirm
deleteBtn.addEventListener('click', () => openModal(modal1));

// proceed to second confirm
confirmStep1.addEventListener('click', () => {
  closeModal(modal1);
  openModal(modal2);
});

// close modals on any close button
document.querySelectorAll('.delete-account-modal-close').forEach(btn => {
    btn.addEventListener('click', e => {
      const modal = e.target.closest('.modal-parent');
      // Only close if we actually found one of our delete modals
      if (modal && (modal.id === 'delete-account-modal' || modal.id === 'delete-account-modal-2')) {
        closeModal(modal);
      }
    });
});

