(function lockMobileZoom() {
    let lastTouchEnd = 0;

    document.addEventListener(
        "touchend",
        (event) => {
            const now = Date.now();

            if (now - lastTouchEnd <= 300) {
                event.preventDefault();
            }

            lastTouchEnd = now;
        },
        { passive: false }
    );

    document.addEventListener(
        "touchmove",
        (event) => {
            if (event.touches && event.touches.length > 1) {
                event.preventDefault();
            }
        },
        { passive: false }
    );

    ["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
        document.addEventListener(eventName, (event) => {
            event.preventDefault();
        });
    });
})();
