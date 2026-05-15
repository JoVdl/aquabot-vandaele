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

// ── Broches moteurs BTS7960 ───────────────────────────────────────────
// Ordre : AV-G, AV-D, AR-G, AR-D (identique aux ancres dans l'app)
// RPWM = avancer (tendre câble), LPWM = reculer (lâcher câble)
const uint8_t MOTOR_RPWM[4] = { 25, 32, 16, 18 };
const uint8_t MOTOR_LPWM[4] = { 26, 33, 17, 19 };
const uint8_t MOTOR_EN[4]   = { 27, 15,  5, 23 };

// ── Pompe (relais SSR 230V) ───────────────────────────────────────────
#define PUMP_PIN  4        // HIGH = pompe ON, LOW = pompe OFF
#define PUMP_ACTIVE_HIGH true

// ── GPS ZED-F9P (I2C) ─────────────────────────────────────────────────
#define GPS_SDA  21
#define GPS_SCL  22
#define GPS_FREQ  5        // Hz — fréquence de mise à jour position

// ── Paramètres de contrôle ────────────────────────────────────────────
#define ARRIVAL_THRESHOLD  0.15f   // m — distance pour considérer la case atteinte
#define CABLE_DEADBAND     0.05f   // m — erreur câble ignorée (évite oscillations)
#define KP_CABLE           80.0f   // gain proportionnel (PWM par mètre d'erreur)
#define MIN_PWM            55      // PWM minimum pour démarrer les moteurs portail
#define MAX_PWM            200     // PWM maximum

// ── Timings ───────────────────────────────────────────────────────────
#define TELEMETRY_INTERVAL_MS   500   // envoi télémétrie vers Firebase
#define COMMAND_POLL_MS         500   // lecture commandes depuis Firebase
#define NTRIP_RECONNECT_MS    10000   // délai avant tentative reconnexion NTRIP
