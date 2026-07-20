/*
 * AquaBot Vandaele — Sketch ESP32
 * Contrôle robot curage autonome par propulsion (moteurs + GPS + boussole)
 *
 * Matériel :
 *   - ESP32 (cerveau principal)
 *   - ZED-F9P GPS RTK (I2C) + antenne GNSS multi-bande
 *   - Magnétomètre I2C QMC5883L (boussole électronique, cap du robot)
 *   - 4× BTS7960 (drivers propulseurs, montage en X aux 4 coins)
 *   - 1× BTS7960 (moteur descente/remontée pompe)
 *   - 1× BTS7960 (moteur sonde bathymétrique — même mécanisme, actionneur séparé)
 *   - Capteur courant (GPIO 34) pour détection fond/haut pompe
 *   - Capteur courant (GPIO 35) pour détection interface vase / fond dur sonde bathymétrique
 *   - Relais SSR 230V (pompe)
 *   - Hotspot 4G (WiFi vers Firebase + Centipède NTRIP)
 *
 * Librairies requises (Gestionnaire de bibliothèques Arduino) :
 *   - SparkFun u-blox GNSS Arduino Library (v3)
 *   - QMC5883LCompass
 *   - ArduinoJson (v6)
 *   - WiFi, HTTPClient, WiFiClientSecure (inclus ESP32 Arduino Core)
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SparkFun_u-blox_GNSS_Arduino_Library.h>
#include <QMC5883LCompass.h>
#include <Wire.h>
#include <math.h>
#include <vector>
#include "config.h"

// ── GPS ───────────────────────────────────────────────────────────────
SFE_UBLOX_GNSS gps;

// ── Boussole ──────────────────────────────────────────────────────────
QMC5883LCompass compass;

// ── NTRIP ─────────────────────────────────────────────────────────────
WiFiClient ntripClient;
bool       ntripConnected    = false;
unsigned long ntripLastTry   = 0;

// ── Structure 2D ─────────────────────────────────────────────────────
struct Vec2 { float x, y; };
float dist2D(Vec2 a, Vec2 b) {
  float dx = b.x - a.x, dy = b.y - a.y;
  return sqrtf(dx*dx + dy*dy);
}

// ── État robot ────────────────────────────────────────────────────────
enum RobotState {
  STATE_IDLE,
  STATE_MOVING,
  STATE_DESCENDING,
  STATE_PUMPING,
  STATE_ASCENDING,
  STATE_PAUSED,
  STATE_DONE,
  STATE_ERROR
};

RobotState robotState    = STATE_IDLE;
RobotState stateBeforePause = STATE_IDLE;

// ── État sonde bathymétrique — exclusif du curage (voir bathyTick) ────
// Ne tourne que si robotState == STATE_IDLE, et un START de curage est refusé tant que
// bathyState != BATHY_IDLE : les deux partagent targetPos/currentPos/controlThrusters()
// sans jamais s'exécuter en même temps.
enum BathyState {
  BATHY_IDLE,
  BATHY_MOVING,
  BATHY_DESCENDING,
  BATHY_ASCENDING,
  BATHY_DONE
};
BathyState bathyState = BATHY_IDLE;
std::vector<Vec2> bathyPath;
int   bathyCurrentIdx   = 0;
float bathyDepth        = 0;
bool  bathyMudFound      = false;
float bathyWaterDepth    = 0;   // relevé en cours — profondeur d'eau (jusqu'à l'interface vase)
float bathyMudDepth      = 0;   // relevé en cours — épaisseur de vase (interface → fond dur)
float p_bathyDescentSpeed = 0.05f;
float p_bathyAscentSpeed  = 0.08f;

// ── Position & navigation ─────────────────────────────────────────────
double originLat = 0, originLng = 0;
bool   originLoaded = false;

Vec2  currentPos   = {0, 0};
Vec2  targetPos    = {0, 0};

std::vector<Vec2> plannedPath;
int  currentCellIdx = 0;

// ── GPS ───────────────────────────────────────────────────────────────
double gpsLat      = 0, gpsLng = 0;
float  gpsAccuracy = 99.0f;
float  gpsSpeed    = 0;    // m/s (ground speed)
float  gpsHeading  = 0;    // degrés, cap GPS (course over ground)
int    fixType     = 0;
int    carrierType = 0;   // 0=no RTK, 1=float, 2=fixed
bool   gpsValid    = false;

// ── Boussole ──────────────────────────────────────────────────────────
float currentHeading = 0;  // degrés, 0 = Nord — cap courant du robot
bool  compassReady   = false;

// ── Pompe / mini-cycles ───────────────────────────────────────────────
float pumpDepth      = 0;
float pumpTimer      = 0;
int   miniCyclesDone = 0;
bool  pumpFullAscent = false;

// ── Énergie / volume — même modèle de puissance que la simulation JS
// (js/app.js: POWER_SPECS/computeInstantPowerBreakdown), pour que l'onglet Énergie affiche
// des valeurs cohérentes que le robot tourne en simulation ou en réel. Ce ne sont pas des
// mesures de courant réelles (sauf le capteur ADC sur le moteur de pompe, utilisé uniquement
// pour la détection fond/haut) — juste une estimation par modèle, comme côté app.
#define POWER_THRUSTER_MAX_W  55.0f
#define POWER_PUMP_W        1800.0f
#define POWER_WINCH_W         80.0f
#define POWER_BATHY_W         80.0f
#define POWER_ELECTRONICS_W    8.0f
float energyWh      = 0;   // cumul depuis le démarrage du robot (persistant tant qu'il reste allumé)
float volumePumped   = 0;   // litres cumulés depuis le démarrage
float p_pumpFlow     = 500.0f; // L/min, reçu depuis l'app (voir pollCommands)

// ── Moteur descente pompe (5ème moteur, BTS7960) ──────────────────────
// Canaux LEDC 8-9 (0-7 occupés par les 4 propulseurs)
#define PUMP_MOTOR_CH_R  8
#define PUMP_MOTOR_CH_L  9
int   pumpMotorPwm   = 0;   // PWM courant (rampe progressive)

// ── Moteur sonde bathymétrique (6ème moteur, BTS7960) — canaux LEDC 10-11
#define BATHY_MOTOR_CH_R  10
#define BATHY_MOTOR_CH_L  11
int   bathyMotorPwm  = 0;   // PWM courant (rampe progressive)

// ── Paramètres reçus depuis l'app ─────────────────────────────────────
float p_pumpTime         = 30.0f;
float p_waterDepth       = 2.0f;
float p_mudDepth         = 0.3f;
float p_pumpDescentSpeed = 0.05f;
float p_pumpAscentSpeed  = 0.08f;
int   p_miniCycles       = 3;

// ── Timing ────────────────────────────────────────────────────────────
unsigned long lastTelemetry   = 0;
unsigned long lastCommandPoll = 0;
unsigned long lastTick        = 0;

// ─────────────────────────────────────────────────────────────────────
// CONVERSION COORDONNÉES
// ─────────────────────────────────────────────────────────────────────
Vec2 gpsToLocal(double lat, double lng) {
  return {
    (float)((lng - originLng) * cos(originLat * M_PI / 180.0) * 111320.0),
    (float)((lat - originLat) * 110540.0)
  };
}

// ─────────────────────────────────────────────────────────────────────
// MOTEURS
// ─────────────────────────────────────────────────────────────────────
void motorSetup() {
  for (int i = 0; i < 4; i++) {
    ledcSetup(i * 2,     5000, 8);
    ledcSetup(i * 2 + 1, 5000, 8);
    ledcAttachPin(MOTOR_RPWM[i], i * 2);
    ledcAttachPin(MOTOR_LPWM[i], i * 2 + 1);
    pinMode(MOTOR_EN[i], OUTPUT);
    digitalWrite(MOTOR_EN[i], HIGH);
    ledcWrite(i * 2,     0);
    ledcWrite(i * 2 + 1, 0);
  }
  // 5ème moteur : descente/remontée pompe
  ledcSetup(PUMP_MOTOR_CH_R, 5000, 8);
  ledcSetup(PUMP_MOTOR_CH_L, 5000, 8);
  ledcAttachPin(PUMP_MOTOR_RPWM, PUMP_MOTOR_CH_R);
  ledcAttachPin(PUMP_MOTOR_LPWM, PUMP_MOTOR_CH_L);
  pinMode(PUMP_MOTOR_EN, OUTPUT);
  digitalWrite(PUMP_MOTOR_EN, HIGH);
  ledcWrite(PUMP_MOTOR_CH_R, 0);
  ledcWrite(PUMP_MOTOR_CH_L, 0);

  // 6ème moteur : sonde bathymétrique — EN relié en direct au 12V (pas de broche ESP32),
  // voir config.h
  ledcSetup(BATHY_MOTOR_CH_R, 5000, 8);
  ledcSetup(BATHY_MOTOR_CH_L, 5000, 8);
  ledcAttachPin(BATHY_MOTOR_RPWM, BATHY_MOTOR_CH_R);
  ledcAttachPin(BATHY_MOTOR_LPWM, BATHY_MOTOR_CH_L);
  ledcWrite(BATHY_MOTOR_CH_R, 0);
  ledcWrite(BATHY_MOTOR_CH_L, 0);

  // Capteurs courant (ADC)
  pinMode(PUMP_CURRENT_PIN, INPUT);
  pinMode(BATHY_CURRENT_PIN, INPUT);

  pinMode(PUMP_PIN, OUTPUT);
  digitalWrite(PUMP_PIN, LOW);
}

// Pousse le propulseur i vers l'avant (poussée positive)
void motorForward(int i, int pwm) {
  ledcWrite(i * 2,     constrain(pwm, 0, 255));
  ledcWrite(i * 2 + 1, 0);
}

// Pousse le propulseur i vers l'arrière (poussée négative)
void motorReverse(int i, int pwm) {
  ledcWrite(i * 2,     0);
  ledcWrite(i * 2 + 1, constrain(pwm, 0, 255));
}

void motorStop(int i) {
  ledcWrite(i * 2, 0);
  ledcWrite(i * 2 + 1, 0);
}

void stopAllMotors() {
  for (int i = 0; i < 4; i++) motorStop(i);
  pumpMotorStop();
  bathyMotorStop();
}

void pumpOn()  { digitalWrite(PUMP_PIN, PUMP_ACTIVE_HIGH ? HIGH : LOW); }
void pumpOff() { digitalWrite(PUMP_PIN, PUMP_ACTIVE_HIGH ? LOW : HIGH); }

// ── Moteur descente/remontée pompe ────────────────────────────────────
// Rampe progressive : pumpMotorPwm monte de PUMP_PWM_START vers targetPwm
// par pas de PUMP_PWM_STEP à chaque appel. Protège les réducteurs portail.

void pumpMotorDescend(int targetPwm) {
  if (pumpMotorPwm < PUMP_PWM_START) pumpMotorPwm = PUMP_PWM_START;
  else pumpMotorPwm = min(pumpMotorPwm + PUMP_PWM_STEP, targetPwm);
  ledcWrite(PUMP_MOTOR_CH_R, pumpMotorPwm);
  ledcWrite(PUMP_MOTOR_CH_L, 0);
}

void pumpMotorAscend(int targetPwm) {
  if (pumpMotorPwm < PUMP_PWM_START) pumpMotorPwm = PUMP_PWM_START;
  else pumpMotorPwm = min(pumpMotorPwm + PUMP_PWM_STEP, targetPwm);
  ledcWrite(PUMP_MOTOR_CH_R, 0);
  ledcWrite(PUMP_MOTOR_CH_L, pumpMotorPwm);
}

void pumpMotorStop() {
  pumpMotorPwm = 0;
  ledcWrite(PUMP_MOTOR_CH_R, 0);
  ledcWrite(PUMP_MOTOR_CH_L, 0);
}

// Lecture courant : moyenne 4 échantillons pour lisser le bruit ADC
int readPumpCurrent() {
  int sum = 0;
  for (int i = 0; i < 4; i++) sum += analogRead(PUMP_CURRENT_PIN);
  return sum / 4;
}

// ── Moteur sonde bathymétrique — même principe de rampe que le moteur de pompe ────────────
void bathyMotorDescend(int targetPwm) {
  if (bathyMotorPwm < BATHY_PWM_START) bathyMotorPwm = BATHY_PWM_START;
  else bathyMotorPwm = min(bathyMotorPwm + BATHY_PWM_STEP, targetPwm);
  ledcWrite(BATHY_MOTOR_CH_R, bathyMotorPwm);
  ledcWrite(BATHY_MOTOR_CH_L, 0);
}
void bathyMotorAscend(int targetPwm) {
  if (bathyMotorPwm < BATHY_PWM_START) bathyMotorPwm = BATHY_PWM_START;
  else bathyMotorPwm = min(bathyMotorPwm + BATHY_PWM_STEP, targetPwm);
  ledcWrite(BATHY_MOTOR_CH_R, 0);
  ledcWrite(BATHY_MOTOR_CH_L, bathyMotorPwm);
}
void bathyMotorStop() {
  bathyMotorPwm = 0;
  ledcWrite(BATHY_MOTOR_CH_R, 0);
  ledcWrite(BATHY_MOTOR_CH_L, 0);
}
int readBathyCurrent() {
  int sum = 0;
  for (int i = 0; i < 4; i++) sum += analogRead(BATHY_CURRENT_PIN);
  return sum / 4;
}

// ─────────────────────────────────────────────────────────────────────
// BOUSSOLE — cap du robot (magnétomètre I2C + repli cap GPS)
// ─────────────────────────────────────────────────────────────────────
void compassSetup() {
  compass.init();
  compassReady = true;
}

void readCompass() {
  compass.read();
  float heading = compass.getAzimuth() + COMPASS_DECLINATION;
  // Recoupement : au-dessus d'une vitesse suffisante, le cap GPS (déplacement
  // réel) est plus fiable que la boussole (bruit magnétique, métal embarqué).
  if (gpsValid && gpsSpeed > COMPASS_GPS_SPEED_MIN) heading = gpsHeading;
  while (heading < 0)    heading += 360;
  while (heading >= 360) heading -= 360;
  currentHeading = heading;
}

// ─────────────────────────────────────────────────────────────────────
// CONTRÔLE DE POSITION PAR PROPULSEURS (GPS + boussole)
//
// Principe : calculer le cap et la distance vers la cible, exprimer ce
// vecteur dans le repère du robot (via le cap boussole), puis répartir la
// poussée sur les 4 propulseurs montés en X. Aucun pivot n'est nécessaire :
// le montage holonome permet de translater directement vers la cible
// depuis l'orientation courante du robot.
// ─────────────────────────────────────────────────────────────────────
float motorThrust[4] = {0, 0, 0, 0}; // dernière poussée appliquée par propulseur (-255..255), pour la télémétrie

void controlThrusters() {
  if (!gpsValid || !compassReady) { stopAllMotors(); return; }

  float dx = targetPos.x - currentPos.x, dy = targetPos.y - currentPos.y;
  float distToTarget = dist2D(currentPos, targetPos);
  if (distToTarget < ARRIVAL_THRESHOLD) { stopAllMotors(); return; }

  float bearingToTarget = atan2f(dx, dy);              // radians, 0 = Nord
  float relRad = bearingToTarget - currentHeading * PI / 180.0f; // cible, repère robot

  float thrustMag = constrain(distToTarget * KP_THRUST, MIN_PWM, MAX_PWM);
  float surge = cosf(relRad) * thrustMag; // avant(+)/arrière(-), repère robot
  float sway  = sinf(relRad) * thrustMag; // droite(+)/gauche(-), repère robot

  const float k = 0.70710678f; // cos(45°) — géométrie des propulseurs en X
  float thrust[4] = {
    (surge - sway) * k, // AV-G
    (surge + sway) * k, // AV-D
    (surge + sway) * k, // AR-G
    (surge - sway) * k, // AR-D
  };

  for (int i = 0; i < 4; i++) {
    motorThrust[i] = constrain(thrust[i], -MAX_PWM, MAX_PWM);
    float mag = fabsf(motorThrust[i]);
    if (mag < MIN_PWM) { motorStop(i); motorThrust[i] = 0; continue; }
    if (motorThrust[i] >= 0) motorForward(i, (int)mag);
    else                     motorReverse(i, (int)mag);
  }
}

// ─────────────────────────────────────────────────────────────────────
// NTRIP — corrections RTK depuis Centipède
// ─────────────────────────────────────────────────────────────────────
bool connectNTRIP() {
  Serial.println("[NTRIP] Connexion à " NTRIP_HOST "...");
  if (!ntripClient.connect(NTRIP_HOST, NTRIP_PORT)) {
    Serial.println("[NTRIP] Echec connexion");
    return false;
  }
  String req = "GET /" + String(NTRIP_MOUNTPOINT) + " HTTP/1.0\r\n"
               "User-Agent: NTRIP AquaBot/1.0\r\n"
               "Authorization: Basic " NTRIP_AUTH_B64 "\r\n"
               "\r\n";
  ntripClient.print(req);
  delay(600);
  // Ignorer l'en-tête HTTP
  while (ntripClient.available()) {
    String line = ntripClient.readStringUntil('\n');
    if (line == "\r") break;
  }
  ntripConnected = true;
  Serial.println("[NTRIP] Connecté — corrections RTK actives");
  return true;
}

void handleNTRIP() {
  if (!ntripConnected || !ntripClient.connected()) {
    ntripConnected = false;
    unsigned long now = millis();
    if (now - ntripLastTry > NTRIP_RECONNECT_MS) {
      ntripLastTry = now;
      connectNTRIP();
    }
    return;
  }
  // Transférer les données RTCM reçues vers le ZED-F9P via I2C
  while (ntripClient.available()) {
    uint8_t b = ntripClient.read();
    gps.pushRawData(&b, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────
// GPS
// ─────────────────────────────────────────────────────────────────────
void readGPS() {
  if (!gps.getPVT(100)) return;
  fixType     = gps.getFixType();
  carrierType = gps.getCarrierSolutionType(); // 0=no RTK, 1=float, 2=fixed
  gpsLat      = gps.getLatitude()  * 1e-7;
  gpsLng      = gps.getLongitude() * 1e-7;
  gpsAccuracy = gps.getPositionAccuracy() / 1000.0f; // mm → m
  gpsSpeed    = gps.getGroundSpeed() / 1000.0f;      // mm/s → m/s
  gpsHeading  = gps.getHeading() * 1e-5f;             // 1e-5° → °

  // Position valide si fix 3D ET origine chargée
  gpsValid = (fixType >= 3) && originLoaded;
  if (gpsValid) {
    currentPos = gpsToLocal(gpsLat, gpsLng);
  }
}

// ─────────────────────────────────────────────────────────────────────
// FIREBASE FIRESTORE REST
// ─────────────────────────────────────────────────────────────────────
String firestoreURL(const String& collection, const String& docId) {
  return "https://firestore.googleapis.com/v1/projects/"
         FIREBASE_PROJECT "/databases/(default)/documents/"
         + collection + "/" + docId + "?key=" FIREBASE_API_KEY;
}

String firestoreGet(const String& col, const String& doc) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  https.begin(client, firestoreURL(col, doc));
  https.setTimeout(5000);
  int code = https.GET();
  String result = (code == 200) ? https.getString() : "";
  https.end();
  return result;
}

bool firestorePatch(const String& col, const String& doc, const String& body) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;
  https.begin(client, firestoreURL(col, doc));
  https.setTimeout(5000);
  https.addHeader("Content-Type", "application/json");
  int code = https.PATCH(body);
  https.end();
  return (code == 200 || code == 201);
}

// Helpers format Firestore
String fsD(float v)        { return "{\"doubleValue\":"  + String(v, 6) + "}"; }
String fsI(int v)          { return "{\"integerValue\":" + String(v) + "}"; }
String fsS(const String& s){ return "{\"stringValue\":\"" + s + "\"}"; }
String fsB(bool b)         { return String("{\"booleanValue\":") + (b?"true":"false") + "}"; }

// ─────────────────────────────────────────────────────────────────────
// LECTURE DES COMMANDES
// ─────────────────────────────────────────────────────────────────────
void pollCommands() {
  String raw = firestoreGet("aquabot_commands", POND_ID);
  if (raw.isEmpty()) return;

  DynamicJsonDocument doc(8192);
  if (deserializeJson(doc, raw) != DeserializationError::Ok) return;

  JsonObject fields = doc["fields"];
  if (fields.isNull()) return;

  String cmd = fields["command"]["stringValue"] | "";
  long   ts  = fields["timestamp"]["integerValue"] | 0L;

  // Ignorer les vieilles commandes (> 10s)
  static long lastCmdTs = 0;
  if (ts <= lastCmdTs) return;
  lastCmdTs = ts;

  Serial.println("[CMD] " + cmd);

  // ── START ─────────────────────────────────────────────────────────
  // Refusé pendant un relevé bathymétrique (bathyState != BATHY_IDLE) : les deux partagent
  // targetPos/currentPos/controlThrusters(), jamais en même temps.
  if (cmd == "start" && (robotState == STATE_IDLE || robotState == STATE_DONE) && bathyState == BATHY_IDLE) {

    // Origine KML
    originLat    = fields["originLat"]["doubleValue"] | 0.0;
    originLng    = fields["originLng"]["doubleValue"] | 0.0;
    originLoaded = (originLat != 0 || originLng != 0);

    // Parcours planifié
    plannedPath.clear();
    JsonArray path = fields["plannedPath"]["arrayValue"]["values"];
    for (JsonVariant v : path) {
      Vec2 p;
      p.x = v["mapValue"]["fields"]["x"]["doubleValue"] | 0.0f;
      p.y = v["mapValue"]["fields"]["y"]["doubleValue"] | 0.0f;
      plannedPath.push_back(p);
    }

    // Paramètres
    p_pumpTime         = fields["pumpTime"]["doubleValue"]         | 30.0f;
    p_waterDepth       = fields["waterDepth"]["doubleValue"]       | 2.0f;
    p_mudDepth         = fields["mudDepth"]["doubleValue"]         | 0.3f;
    p_pumpDescentSpeed = fields["pumpDescentSpeed"]["doubleValue"] | 0.05f;
    p_pumpAscentSpeed  = fields["pumpAscentSpeed"]["doubleValue"]  | 0.08f;
    p_miniCycles       = fields["miniCycles"]["integerValue"]      | 3;
    p_pumpFlow         = fields["pumpFlow"]["doubleValue"]         | 500.0f;

    if (!plannedPath.empty()) {
      currentCellIdx = 0;
      targetPos      = plannedPath[0];
      robotState     = STATE_MOVING;
      Serial.println("[START] " + String(plannedPath.size()) + " cases");
    }
  }

  // ── PAUSE ─────────────────────────────────────────────────────────
  else if (cmd == "pause" && robotState == STATE_MOVING) {
    stateBeforePause = robotState;
    stopAllMotors();
    robotState = STATE_PAUSED;
  }

  // ── RESUME ────────────────────────────────────────────────────────
  else if (cmd == "resume" && robotState == STATE_PAUSED) {
    robotState = stateBeforePause;
  }

  // ── STOP ──────────────────────────────────────────────────────────
  else if (cmd == "stop") {
    stopAllMotors();
    pumpOff();
    pumpDepth      = 0;
    miniCyclesDone = 0;
    currentCellIdx = 0;
    robotState     = STATE_IDLE;
    bathyState      = BATHY_IDLE;
    bathyCurrentIdx = 0;
    bathyDepth      = 0;
    bathyMudFound   = false;
  }

  // ── BATHY_START ───────────────────────────────────────────────────
  // Relevé bathymétrique — parcourt bathyPath (même format que plannedPath) et mesure la
  // profondeur d'eau/vase à chaque case. Refusé pendant un curage (robotState != STATE_IDLE).
  else if (cmd == "bathy_start" && bathyState == BATHY_IDLE && robotState == STATE_IDLE) {
    originLat    = fields["originLat"]["doubleValue"] | 0.0;
    originLng    = fields["originLng"]["doubleValue"] | 0.0;
    originLoaded = (originLat != 0 || originLng != 0);

    bathyPath.clear();
    JsonArray path = fields["bathyPath"]["arrayValue"]["values"];
    for (JsonVariant v : path) {
      Vec2 p;
      p.x = v["mapValue"]["fields"]["x"]["doubleValue"] | 0.0f;
      p.y = v["mapValue"]["fields"]["y"]["doubleValue"] | 0.0f;
      bathyPath.push_back(p);
    }
    p_bathyDescentSpeed = fields["bathyDescentSpeed"]["doubleValue"] | 0.05f;
    p_bathyAscentSpeed  = fields["bathyAscentSpeed"]["doubleValue"]  | 0.08f;

    if (!bathyPath.empty()) {
      bathyCurrentIdx = 0;
      targetPos       = bathyPath[0];
      bathyState      = BATHY_MOVING;
      Serial.println("[BATHY_START] " + String(bathyPath.size()) + " cases");
    }
  }

  // ── BATHY_STOP ────────────────────────────────────────────────────
  else if (cmd == "bathy_stop") {
    bathyMotorStop();
    if (bathyState != BATHY_IDLE) stopAllMotors();
    bathyState      = BATHY_IDLE;
    bathyCurrentIdx = 0;
    bathyDepth      = 0;
    bathyMudFound   = false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// ENVOI TÉLÉMÉTRIE
// ─────────────────────────────────────────────────────────────────────
void sendTelemetry() {
  // Conversion état → string
  const char* robotStateStr;
  switch (robotState) {
    case STATE_MOVING:    robotStateStr = "moving";    break;
    case STATE_DESCENDING:
    case STATE_PUMPING:
    case STATE_ASCENDING: robotStateStr = "pumping";   break;
    case STATE_PAUSED:    robotStateStr = "paused";    break;
    case STATE_DONE:      robotStateStr = "stopped";   break;
    default:              robotStateStr = "stopped";   break;
  }

  const char* pumpStateStr;
  switch (robotState) {
    case STATE_DESCENDING: pumpStateStr = "descending";        break;
    case STATE_PUMPING:    pumpStateStr = "pumping";           break;
    case STATE_ASCENDING:
      pumpStateStr = pumpFullAscent ? "ascending" : "partial_ascending";
      break;
    default: pumpStateStr = "idle"; break;
  }

  const char* bathyStateStr;
  switch (bathyState) {
    case BATHY_MOVING:     bathyStateStr = "moving";     break;
    case BATHY_DESCENDING: bathyStateStr = "descending"; break;
    case BATHY_ASCENDING:  bathyStateStr = "ascending";  break;
    case BATHY_DONE:       bathyStateStr = "done";       break;
    default:               bathyStateStr = "idle";       break;
  }

  // Fix type lisible
  String fixStr = "Pas de fix";
  if (carrierType == 2)    fixStr = "RTK Fixé";
  else if (carrierType == 1) fixStr = "RTK Flottant";
  else if (fixType >= 3)   fixStr = "GPS 3D";

  String body = "{\"fields\":{"
    "\"lat\":"           + fsD(gpsLat)       + ","
    "\"lng\":"           + fsD(gpsLng)       + ","
    "\"x\":"             + fsD(currentPos.x) + ","
    "\"y\":"             + fsD(currentPos.y) + ","
    "\"fixType\":"       + fsI(fixType)      + ","
    "\"carrierType\":"   + fsI(carrierType)  + ","
    "\"fixLabel\":"      + fsS(fixStr)       + ","
    "\"accuracy\":"      + fsD(gpsAccuracy)  + ","
    "\"robotState\":"    + fsS(robotStateStr) + ","
    "\"pumpState\":"     + fsS(pumpStateStr)  + ","
    "\"pumpDepth\":"     + fsD(pumpDepth)     + ","
    "\"pumpTimer\":"     + fsD(pumpTimer)     + ","
    "\"energyWh\":"      + fsD(energyWh)      + ","
    "\"volumePumped\":"  + fsD(volumePumped)  + ","
    "\"miniCyclesDone\":" + fsI(miniCyclesDone) + ","
    "\"currentCellIdx\":" + fsI(currentCellIdx) + ","
    "\"heading\":"       + fsD(currentHeading) + ","
    // motorThrust est en PWM brut (-255..255) — l'app (côté simulation comme réel) attend un
    // pourcentage (-100..100), voir computeInstantPowerBreakdown() dans js/app.js.
    "\"motor0\":"        + fsD(motorThrust[0] / 255.0f * 100.0f) + ","
    "\"motor1\":"        + fsD(motorThrust[1] / 255.0f * 100.0f) + ","
    "\"motor2\":"        + fsD(motorThrust[2] / 255.0f * 100.0f) + ","
    "\"motor3\":"        + fsD(motorThrust[3] / 255.0f * 100.0f) + ","
    "\"simRunning\":"    + fsB(robotState == STATE_MOVING || robotState == STATE_DESCENDING || robotState == STATE_PUMPING || robotState == STATE_ASCENDING) + ","
    "\"bathyState\":"       + fsS(bathyStateStr)         + ","
    "\"bathyCellIdx\":"     + fsI(bathyCurrentIdx)       + ","
    "\"bathyWaterDepth\":"  + fsD(bathyWaterDepth)       + ","
    "\"bathyMudDepth\":"    + fsD(bathyMudDepth)         + ","
    "\"timestamp\":"     + fsI((int)(millis() / 1000)) +
    "}}";

  firestorePatch("aquabot_telemetry", POND_ID, body);
}

// Puissance instantanée estimée (W), même modèle que computeInstantPowerBreakdown() côté JS —
// la pompe (relais 230V) reste comptée comme active tout au long des mini-cycles d'une case
// (descente → pompage → remontée partielle...), pas seulement pendant STATE_PUMPING, pour les
// mêmes raisons que côté simulation (éviter les coupures courtes et répétées de la pompe).
float computeInstantPowerW() {
  float thrustersW = 0;
  for (int i = 0; i < 4; i++) {
    float frac = min(1.0f, fabsf(motorThrust[i]) / 255.0f);
    thrustersW += POWER_THRUSTER_MAX_W * powf(frac, 1.5f);
  }
  bool pumpActive  = (robotState == STATE_DESCENDING || robotState == STATE_PUMPING || robotState == STATE_ASCENDING);
  bool winchActive = (robotState == STATE_DESCENDING || robotState == STATE_ASCENDING);
  bool bathyActive = (bathyState == BATHY_DESCENDING || bathyState == BATHY_ASCENDING);
  return thrustersW + (pumpActive ? POWER_PUMP_W : 0) + (winchActive ? POWER_WINCH_W : 0)
       + (bathyActive ? POWER_BATHY_W : 0) + POWER_ELECTRONICS_W;
}

// ─────────────────────────────────────────────────────────────────────
// BOUCLE ROBOT (machine à états)
// ─────────────────────────────────────────────────────────────────────
void robotTick(float dt) {
  const float fullDepth    = p_waterDepth + p_mudDepth;
  const float partialDepth = p_waterDepth;

  energyWh += computeInstantPowerW() * dt / 3600.0f;
  if (robotState == STATE_PUMPING) volumePumped += (p_pumpFlow / 60.0f) * dt;

  switch (robotState) {

    // ── Déplacement vers la case cible ────────────────────────────
    case STATE_MOVING: {
      controlThrusters();
      if (gpsValid && dist2D(currentPos, targetPos) < ARRIVAL_THRESHOLD) {
        stopAllMotors();
        pumpDepth      = 0;
        miniCyclesDone = 0;
        pumpFullAscent = false;
        robotState     = STATE_DESCENDING;
        Serial.println("[ROBOT] Arrivé case " + String(currentCellIdx));
      }
      break;
    }

    // ── Descente pompe dans la vase ────────────────────────────────
    // Moteur descend jusqu'à détection courant (fond) ou profondeur max
    case STATE_DESCENDING: {
      pumpMotorDescend(PUMP_PWM_DESCENT);
      pumpDepth = min(fullDepth, pumpDepth + p_pumpDescentSpeed * dt);

      bool bottomDetected = false;
      if (PUMP_USE_CURRENT_SENSING) {
        bottomDetected = (readPumpCurrent() > PUMP_I_THRESHOLD_DESCENT);
      }
      // Fond atteint : par courant OU par profondeur max
      if (bottomDetected || pumpDepth >= fullDepth - 0.005f) {
        pumpMotorStop();
        pumpDepth  = fullDepth;
        pumpTimer  = 0;
        pumpFullAscent = false;
        pumpOn();
        robotState = STATE_PUMPING;
        Serial.println("[POMPE] ON — cycle " + String(miniCyclesDone + 1) + "/" + String(p_miniCycles)
                       + (bottomDetected ? " (courant)" : " (profondeur)"));
      }
      break;
    }

    // ── Pompage ────────────────────────────────────────────────────
    case STATE_PUMPING: {
      pumpTimer += dt;
      if (pumpTimer >= p_pumpTime) {
        miniCyclesDone++;
        if (miniCyclesDone < p_miniCycles) {
          pumpFullAscent = false;
        } else {
          pumpFullAscent = true;
          miniCyclesDone = 0;
          pumpOff();
          Serial.println("[POMPE] OFF");
        }
        robotState = STATE_ASCENDING;
      }
      break;
    }

    // ── Remontée pompe ─────────────────────────────────────────────
    // Moteur remonte jusqu'à détection courant (haut) ou profondeur cible
    case STATE_ASCENDING: {
      float targetDepth = pumpFullAscent ? 0.0f : partialDepth;
      pumpMotorAscend(PUMP_PWM_ASCENT);
      pumpDepth = max(targetDepth, pumpDepth - p_pumpAscentSpeed * dt);

      bool topDetected = false;
      if (PUMP_USE_CURRENT_SENSING && pumpFullAscent) {
        // Détection haut seulement pour la remontée complète
        topDetected = (readPumpCurrent() > PUMP_I_THRESHOLD_ASCENT);
      }

      if (topDetected || pumpDepth <= targetDepth + 0.005f) {
        pumpMotorStop();
        pumpDepth = targetDepth;
        if (topDetected) Serial.println("[POMPE] Haut détecté (courant)");

        if (pumpFullAscent) {
          currentCellIdx++;
          if (currentCellIdx >= (int)plannedPath.size()) {
            robotState = STATE_DONE;
            stopAllMotors();
            Serial.println("[ROBOT] Parcours terminé !");
          } else {
            targetPos  = plannedPath[currentCellIdx];
            robotState = STATE_MOVING;
          }
        } else {
          pumpTimer  = 0;
          robotState = STATE_DESCENDING;
        }
      }
      break;
    }

    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────
// BOUCLE SONDE BATHYMÉTRIQUE — exclusif du curage (voir bathyState plus haut)
// ─────────────────────────────────────────────────────────────────────
// Descente en deux temps : d'abord jusqu'à l'interface eau/vase (courant modéré, on note
// bathyWaterDepth), puis jusqu'au fond dur (courant max, on note bathyMudDepth = distance
// parcourue depuis l'interface). Sécurité de profondeur max en dur si les seuils de courant
// ne se déclenchent jamais (capteur en panne, plaque coincée...).
#define BATHY_MAX_DEPTH_SAFETY 6.0f

void bathyTick(float dt) {
  energyWh += computeInstantPowerW() * dt / 3600.0f;

  switch (bathyState) {

    case BATHY_MOVING: {
      controlThrusters();
      if (gpsValid && dist2D(currentPos, targetPos) < ARRIVAL_THRESHOLD) {
        stopAllMotors();
        bathyDepth      = 0;
        bathyMudFound   = false;
        bathyWaterDepth = 0;
        bathyMudDepth   = 0;
        bathyState      = BATHY_DESCENDING;
        Serial.println("[BATHY] Arrivé case " + String(bathyCurrentIdx));
      }
      break;
    }

    case BATHY_DESCENDING: {
      bathyMotorDescend(BATHY_PWM_DESCENT);
      bathyDepth += p_bathyDescentSpeed * dt;
      int current = readBathyCurrent();

      if (!bathyMudFound && current > BATHY_I_THRESHOLD_MUD) {
        bathyMudFound   = true;
        bathyWaterDepth = bathyDepth;
        Serial.println("[BATHY] Interface eau/vase à " + String(bathyDepth, 2) + "m");
      }

      bool bottomDetected = bathyMudFound && (current > BATHY_I_THRESHOLD_BOTTOM);
      if (bottomDetected || bathyDepth >= BATHY_MAX_DEPTH_SAFETY) {
        bathyMotorStop();
        if (!bathyMudFound) bathyWaterDepth = bathyDepth; // pas de vase détectée — fond dur direct
        bathyMudDepth = max(0.0f, bathyDepth - bathyWaterDepth);
        Serial.println("[BATHY] Fond dur — eau=" + String(bathyWaterDepth, 2) + "m vase=" + String(bathyMudDepth, 2) + "m");
        bathyState = BATHY_ASCENDING;
      }
      break;
    }

    case BATHY_ASCENDING: {
      bathyMotorAscend(BATHY_PWM_ASCENT);
      bathyDepth = max(0.0f, bathyDepth - p_bathyAscentSpeed * dt);
      if (bathyDepth <= 0.005f) {
        bathyMotorStop();
        bathyDepth = 0;
        bathyCurrentIdx++;
        if (bathyCurrentIdx >= (int)bathyPath.size()) {
          bathyState = BATHY_DONE;
          stopAllMotors();
          Serial.println("[BATHY] Relevé terminé !");
        } else {
          targetPos  = bathyPath[bathyCurrentIdx];
          bathyState = BATHY_MOVING;
        }
      }
      break;
    }

    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== AquaBot ESP32 ===");

  motorSetup();

  // WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] Connexion");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" OK — IP: " + WiFi.localIP().toString());
  } else {
    Serial.println(" ECHEC — vérifier SSID/mot de passe");
  }

  // GPS ZED-F9P + boussole (bus I2C partagé)
  Wire.begin(GPS_SDA, GPS_SCL);
  if (!gps.begin()) {
    Serial.println("[GPS] ZED-F9P non détecté — vérifier câblage I2C");
  } else {
    gps.setI2COutput(COM_TYPE_UBX);
    gps.setNavigationFrequency(GPS_FREQ);
    gps.setAutoPVT(true);
    Serial.println("[GPS] ZED-F9P OK — " + String(GPS_FREQ) + "Hz");
  }
  compassSetup();
  Serial.println("[BOUSSOLE] QMC5883L prête");

  // NTRIP Centipède
  connectNTRIP();

  lastTick = millis();
  Serial.println("[INIT] Prêt — en attente de commandes Firebase");
}

// ─────────────────────────────────────────────────────────────────────
// LOOP
// ─────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();
  float dt = constrain((now - lastTick) / 1000.0f, 0.0f, 0.2f);
  lastTick = now;

  // Corrections RTK → GPS
  handleNTRIP();

  // Lecture position GPS + cap boussole
  readGPS();
  readCompass();

  // Boucle robot
  if (robotState != STATE_IDLE && robotState != STATE_PAUSED && robotState != STATE_DONE) {
    robotTick(dt);
  }

  // Boucle sonde bathymétrique — exclusive du curage (voir bathyState)
  if (bathyState != BATHY_IDLE && bathyState != BATHY_DONE) {
    bathyTick(dt);
  }

  // Polling commandes Firebase
  if (now - lastCommandPoll >= COMMAND_POLL_MS) {
    lastCommandPoll = now;
    if (WiFi.status() == WL_CONNECTED) pollCommands();
    else WiFi.reconnect();
  }

  // Envoi télémétrie
  if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
    lastTelemetry = now;
    if (WiFi.status() == WL_CONNECTED) sendTelemetry();
  }
}
