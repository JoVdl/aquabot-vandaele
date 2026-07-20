#pragma once

// ── WiFi (hotspot 4G) ─────────────────────────────────────────────────
#define WIFI_SSID     "MonHotspot4G"
#define WIFI_PASSWORD "motdepasse"

// ── Firebase ──────────────────────────────────────────────────────────
#define FIREBASE_API_KEY  "AIzaSyAjPotBmK9IQ-HDoqwI0BoYggZrKsxHRxY"
#define FIREBASE_PROJECT  "aquabot-vandaele"

// ID de l'étang actif — récupérer depuis l'app (affiché dans l'URL ou les logs)
#define POND_ID  "1778778441776"

// ── NTRIP Centipède (corrections RTK via internet) ────────────────────
#define NTRIP_HOST        "caster.centipede.fr"
#define NTRIP_PORT        2101
#define NTRIP_MOUNTPOINT  "NEAREST"        // sélection auto de la base la plus proche
#define NTRIP_USER        "centipede"
#define NTRIP_PASS        "centipede"
// Base64("centipede:centipede") — ne pas modifier
#define NTRIP_AUTH_B64    "Y2VudGlwZWRlOmNlbnRpcGVkZQ=="

// ── Broches propulseurs BTS7960 ────────────────────────────────────────
// 4 propulseurs bidirectionnels montés aux 4 coins de la plateforme, en
// configuration X (45° de l'axe avant-arrière) : AV-G, AV-D, AR-G, AR-D.
// Ce montage holonome permet d'avancer/reculer/translater latéralement et
// de pivoter indépendamment — utile pour tenir position pendant le pompage.
// RPWM = poussée avant (sens du propulseur), LPWM = poussée arrière (inversé)
const uint8_t MOTOR_RPWM[4] = { 25, 32, 16, 18 };
const uint8_t MOTOR_LPWM[4] = { 26, 33, 17, 19 };
const uint8_t MOTOR_EN[4]   = { 27, 15,  5, 23 };

// ── Pompe (relais SSR 230V) ───────────────────────────────────────────
#define PUMP_PIN  4        // HIGH = pompe ON, LOW = pompe OFF
#define PUMP_ACTIVE_HIGH true

// ── 5ème moteur : descente/remontée pompe (BTS7960) ───────────────────
// ⚠ Broches à confirmer selon câblage réel
#define PUMP_MOTOR_RPWM  13   // descente (RPWM → lâcher cable portique)
#define PUMP_MOTOR_LPWM  12   // remontée (LPWM → enrouler cable portique)
#define PUMP_MOTOR_EN    14

// Capteur de courant (GPIO 34 = entrée ADC uniquement, 0–4095 sur ESP32)
#define PUMP_CURRENT_PIN         34
#define PUMP_USE_CURRENT_SENSING true   // false = uniquement time-based
#define PUMP_I_THRESHOLD_DESCENT  800   // ADC raw → fond détecté (descente)
#define PUMP_I_THRESHOLD_ASCENT   900   // ADC raw → haut détecté (remontée)

// PWM rampe pompe 8 bits (0–255), calqué sur ancien code 10-bit /4
#define PUMP_PWM_START    75    // démarrage doux (≈ 300/1023*255)
#define PUMP_PWM_DESCENT 150    // max descente   (≈ 600/1023*255)
#define PUMP_PWM_ASCENT  255    // max remontée   (pleine puissance)
#define PUMP_PWM_STEP      2    // incrément par tick (≈ 10/1023*255, mode normal)

// ── 6ème moteur : sonde bathymétrique (BTS7960) ───────────────────────
// Même principe que le moteur de descente pompe : portail 12V + crémaillère verticale,
// mais actionneur dédié séparé (plaque 10×10cm en bout de tige, pour relever la profondeur
// d'eau et de vase case par case, indépendamment du cycle de pompage — voir bathyTick()).
// EN relié en direct au 12V (pont/jumper sur le module BTS7960, pas de broche ESP32 dédiée) —
// libère une broche sur un ESP32 déjà chargé en GPIO ; la plupart des modules BTS7960 le
// permettent. RPWM/LPWM sur des broches de boot (0) : sans composant externe qui tire cette
// broche au niveau bas au démarrage, ça ne pose pas de problème en pratique.
#define BATHY_MOTOR_RPWM  2
#define BATHY_MOTOR_LPWM  0

// Capteur de courant dédié (broche ADC entrée seule, 35 — libre, contrairement à 32/33/34
// déjà utilisées par les propulseurs et la pompe)
#define BATHY_CURRENT_PIN  35

// Deux seuils pendant la descente (contrairement à la pompe qui n'en a qu'un, "fond") :
// la plaque rencontre d'abord une résistance modérée en entrant dans la vase (interface
// eau/vase), puis un courant maximal en touchant le fond dur.
#define BATHY_I_THRESHOLD_MUD     600   // ADC raw → interface eau/vase détectée
#define BATHY_I_THRESHOLD_BOTTOM  950   // ADC raw → fond dur détecté

// PWM rampe sonde bathymétrique (mêmes valeurs que la rampe pompe, mécanisme identique)
#define BATHY_PWM_START    75
#define BATHY_PWM_DESCENT 150
#define BATHY_PWM_ASCENT  255
#define BATHY_PWM_STEP      2

// ── GPS ZED-F9P (I2C) ─────────────────────────────────────────────────
#define GPS_SDA  21
#define GPS_SCL  22
#define GPS_FREQ  5        // Hz — fréquence de mise à jour position

// ── Boussole électronique (magnétomètre I2C, ex. QMC5883L) ────────────
// Partage le même bus I2C que le GPS. Donne le cap du robot à l'arrêt ou à
// faible vitesse, quand le cap GPS (course over ground) n'est pas fiable.
#define COMPASS_I2C_ADDR      0x0D
#define COMPASS_DECLINATION   0.0f   // déclinaison magnétique locale, degrés
#define COMPASS_GPS_SPEED_MIN 0.3f   // m/s — au-dessus, on peut recouper avec le cap GPS

// ── Paramètres de contrôle ────────────────────────────────────────────
// Pas de contrôle de cap actif : les 4 propulseurs en X permettent d'avancer
// dans n'importe quelle direction (translation pure) depuis l'orientation
// courante du robot, sans avoir besoin de pivoter — la boussole sert
// uniquement à convertir le cap (monde) vers le repère du robot.
#define ARRIVAL_THRESHOLD   0.15f  // m — distance pour considérer la case atteinte
#define KP_THRUST           120.0f // gain proportionnel avance/translation (PWM par mètre d'erreur)
#define MIN_PWM             55     // PWM minimum pour démarrer les propulseurs
#define MAX_PWM             200    // PWM maximum

// ── Timings ───────────────────────────────────────────────────────────
#define TELEMETRY_INTERVAL_MS   500   // envoi télémétrie vers Firebase
#define COMMAND_POLL_MS         500   // lecture commandes depuis Firebase
#define NTRIP_RECONNECT_MS    10000   // délai avant tentative reconnexion NTRIP
