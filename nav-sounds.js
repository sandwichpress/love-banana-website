/**
 * Navigation Panel Sound Effects
 * Plays a unique LinnDrum sample when each nav panel is clicked.
 */
(function () {
    // Map each nav panel (by alt text) to its sound file
    const navSounds = {
        'Merch': 'Sounds/Reverb LinnDrum Sample Pack_Clap.wav',
        'Shows': 'Sounds/Reverb LinnDrum Sample Pack_Kick Hard.wav',
        'Links': 'Sounds/Reverb LinnDrum Sample Pack_Cowbell.wav',
        'Gallery': 'Sounds/Reverb LinnDrum Sample Pack_Tambourine Hard.wav'
    };

    // Preload audio objects for instant playback
    const audioCache = {};
    for (const [name, src] of Object.entries(navSounds)) {
        const audio = new Audio(src);
        audio.preload = 'auto';
        audioCache[name] = audio;
    }

    document.addEventListener('DOMContentLoaded', function () {
        const navItems = document.querySelectorAll('.nav-item');

        navItems.forEach(function (item) {
            const img = item.querySelector('img');
            if (!img) return;

            const alt = img.getAttribute('alt');
            const audio = audioCache[alt];
            if (!audio) return;

            item.addEventListener('click', function (e) {
                // Prevent default navigation momentarily so sound plays
                e.preventDefault();
                const href = item.getAttribute('href');

                // Clone the audio so overlapping clicks work
                const sound = audio.cloneNode();
                sound.volume = 1.0;
                sound.play().catch(function () {
                    // Autoplay policy may block — navigate anyway
                });

                // Short delay to let the sound start, then navigate
                setTimeout(function () {
                    if (href) {
                        window.location.href = href;
                    }
                }, 150);
            });
        });
    });
})();
