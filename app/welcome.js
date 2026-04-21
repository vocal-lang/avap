// Welcome modal logic only
// (Renamed from questionnaire.js)
document.addEventListener('DOMContentLoaded', function() {
    const welcomeModal = document.getElementById('welcomeModal');
    // Show the modal only on the user's very first visit (across all tabs)
    try {
        // Show the modal only once per browser session (tab)
        if (welcomeModal && !sessionStorage.getItem('welcomeModalShown')) {
            welcomeModal.style.display = 'flex';
            sessionStorage.setItem('welcomeModalShown', 'true');
        } else if (welcomeModal) {
            welcomeModal.style.display = 'none';
        }
        const closeBtn = document.getElementById('closeWelcomeModal');
        if (closeBtn) {
            closeBtn.addEventListener('click', function() {
                if (welcomeModal) welcomeModal.style.display = 'none';
            });
        }
        const emergencyYes = document.getElementById('emergencyYes');
        const emergencyNo = document.getElementById('emergencyNo');
        if (emergencyYes) {
            emergencyYes.addEventListener('click', function() {
                window.location.href = 'hotline.html';
            });
        }
        if (emergencyNo) {
            emergencyNo.addEventListener('click', function() {
                if (welcomeModal) welcomeModal.style.display = 'none';
            });
        }
    } catch (e) {
        // Fail silently if any error occurs
        console.warn('Welcome modal error:', e);
    }
});
