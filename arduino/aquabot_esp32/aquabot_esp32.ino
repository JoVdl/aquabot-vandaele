/*
 * AquaBot Vandaele — Sketch ESP32
 * Contrôle robot curage autonome par câbles
 *
 * Matériel :
 *   - ESP32 (cerveau principal)
 *   - ZED-F9P GPS RTK (I2C) + antenne GNSS multi-bande
 *   - 4× BTS7960 (drivers moteurs treuils)
 *   - Relais SSR 230V (pompe)
 *   - Hotspot 4G (WiFi vers Firebase + Centipède NTRIP)
 *
 * Librairies requises (Gestionnaire de bibliothèques Arduino) :
 *   - SparkFun u-blox GNSS Arduino Library (v3)
 *   - ArduinoJson (v6)
 *   - WiFi, HTTPClient, WiFiClientSecure (inclus ESP32 Arduino Core)
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SparkFun_u-blox_GNSS_Arduino_Library.h>
#include <Wire.h>
#include <math.h>
#include <vector>
#include "config.h"

// ── GPS ───────────────────────────────────────────────────────────────
SFE_UBLOX_GNSS gps;

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

// ── Position & navigation ─────────────────────────────────────────────
double originLat = 0, originLng = 0;
bool   originLoaded = false;

Vec2  currentPos   = {0, 0};
Vec2  targetPos    = {0, 0};
Vec2  anchors[4]   = {};
bool  anchorsLoaded = false;

std::vector<Vec2> plannedPath;
int  currentCellIdx = 0;

// ── GPS ───────────────────────────────────────────────────────────────
double gpsLat      = 0, gpsLng = 0;
float  gpsAccuracy = 99.0f;
int    fixType     = 0;
int    carrierType = 0;   // 0=no RTK, 1=float, 2=fixed
bool   gpsValid    = false;

// ── Pompe / mini-cycles ───────────────────────────────────────────────
float pumpDepth      = 0;
float pumpTimer      = 0;
int   miniCyclesDone = 0;
bool  pumpFullAscent = false;

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
    ledcSetup(i * 2,     5000, 8);   // canal RPWM
    ledcSetup(i * 2 + 1, 5000, 8);   // canal LPWM
    ledcAttachPin(MOTOR_RPWM[i], i * 2);
    ledcAttachPin(MOTOR_LPWM[i], i * 2 + 1);
    pinMode(MOTOR_EN[i], OUTPUT);
    digitalWrite(MOTOR_EN[i], HIGH);
    ledcWrite(i * 2,     0);
    ledcWrite(i * 2 + 1, 0);
  }
  pinMode(PUMP_PIN, OUTPUT);
  digitalWrite(PUMP_PIN, LOW);
}

// Tendre le câble i (raccourcir)
void motorTighten(int i, int pwm) {
  ledcWrite(i * 2,     constrain(pwm, 0, 255));
  ledcWrite(i * 2 + 1, 0);
}

// Lâcher le câble i (allonger)
void motorLoosen(int i, int pwm) {
  ledcWrite(i * 2,     0);
  ledcWrite(i * 2 + 1, constrain(pwm, 0, 255));
}

void motorStop(int i) {
  ledcWrite(i * 2, 0);
  ledcWrite(i * 2 + 1, 0);
}

void stopAllMotors() {
  for (int i = 0; i < 4; i++) motorStop(i);
}

void pumpOn()  { digitalWrite(PUMP_PIN, PUMP_ACTIVE_HIGH ? HIGH : LOW); }
void pumpOff() { digitalWrite(PUMP_PIN, PUMP_ACTIVE_HIGH ? LOW : HIGH); }

// ─────────────────────────────────────────────────────────────────────
// CONTRÔLE DE POSITION PAR CÂBLES (GPS comme feedback)
//
// Principe : calculer la longueur de câble nécessaire pour être à
// la position cible, comparer à la longueur actuelle (déduite du GPS),
// ajuster chaque moteur proportionnellement à l'erreur.
// ─────────────────────────────────────────────────────────────────────
void controlCables() {
  if (!gpsValid || !anchorsLoaded) {
    stopAllMotors();
    return;
  }
  for (int i = 0; i < 4; i++) {
    float currentLen = dist2D(currentPos, anchors[i]);
    float targetLen  = dist2D(targetPos,  anchors[i]);
    float error = targetLen - currentLen;  // >0 = trop court → lâcher, <0 = trop long → tendre

    if (fabsf(error) < CABLE_DEADBAND) {
      motorStop(i);
    } else {
      int pwm = (int)constrain(fabsf(error) * KP_CABLE, MIN_PWM, MAX_PWM);
      if (error > 0) motorLoosen(i, pwm);
      else           motorTighten(i, pwm);
    }
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
  if (cmd == "start" && (robotState == STATE_IDLE || robotState == STATE_DONE)) {

    // Origine KML
    originLat    = fields["originLat"]["doubleValue"] | 0.0;
    originLng    = fields["originLng"]["doubleValue"] | 0.0;
    originLoaded = (originLat != 0 || originLng != 0);

    // Ancres
    JsonArray anch = fields["anchors"]["arrayValue"]["values"];
    for (int i = 0; i < 4 && i < (int)anch.size(); i++) {
      anchors[i].x = anch[i]["mapValue"]["fields"]["x"]["doubleValue"] | 0.0f;
      anchors[i].y = anch[i]["mapValue"]["fields"]["y"]["doubleValue"] | 0.0f;
    }
    anchorsLoaded = true;

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
  }
}

// ─────────────────────────────────────────────────────────────────────
// ENVOI TÉLÉMÉTRIE
// ─────────────────────────────────────────────────────────────────────
void sendTelemetry() {
  // Longueurs câbles calculées depuis la position GPS actuelle
  float cables[4];
  for (int i = 0; i < 4; i++)
    cables[i] = anchorsLoaded ? dist2D(currentPos, anchors[i]) : 0.0f;

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
    "\"miniCyclesDone\":" + fsI(miniCyclesDone) + ","
    "\"currentCellIdx\":" + fsI(currentCellIdx) + ","
    "\"cable0\":"        + fsD(cables[0])    + ","
    "\"cable1\":"        + fsD(cables[1])    + ","
    "\"cable2\":"        + fsD(cables[2])    + ","
    "\"cable3\":"        + fsD(cables[3])    + ","
    "\"simRunning\":"    + fsB(robotState == STATE_MOVING || robotState == STATE_DESCENDING || robotState == STATE_PUMPING || robotState == STATE_ASCENDING) + ","
    "\"timestamp\":"     + fsI((int)(millis() / 1000)) +
    "}}";

  firestorePatch("aquabot_telemetry", POND_ID, body);
}

// ─────────────────────────────────────────────────────────────────────
// BOUCLE ROBOT (machine à états)
// ─────────────────────────────────────────────────────────────────────
void robotTick(float dt) {
  const float fullDepth    = p_waterDepth + p_mudDepth;
  const float partialDepth = p_waterDepth;

  switch (robotState) {

    // ── Déplacement vers la case cible ────────────────────────────
    case STATE_MOVING: {
      controlCables();
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
    case STATE_DESCENDING: {
      pumpDepth = min(fullDepth, pumpDepth + p_pumpDescentSpeed * dt);
      if (pumpDepth >= fullDepth - 0.005f) {
        pumpDepth  = fullDepth;
        pumpTimer  = 0;
        pumpFullAscent = false;
        pumpOn();
        robotState = STATE_PUMPING;
        Serial.println("[POMPE] ON — cycle " + String(miniCyclesDone + 1) + "/" + String(p_miniCycles));
      }
      break;
    }

    // ── Pompage ────────────────────────────────────────────────────
    case STATE_PUMPING: {
      pumpTimer += dt;
      if (pumpTimer >= p_pumpTime) {
        miniCyclesDone++;
        if (miniCyclesDone < p_miniCycles) {
          // Mini-cycle : remontée partielle puis redescente
          pumpFullAscent = false;
        } else {
          // Tous les cycles terminés : remontée complète
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
    case STATE_ASCENDING: {
      float targetDepth = pumpFullAscent ? 0.0f : partialDepth;
      pumpDepth = max(targetDepth, pumpDepth - p_pumpAscentSpeed * dt);

      if (pumpDepth <= targetDepth + 0.005f) {
        pumpDepth = targetDepth;
        if (pumpFullAscent) {
          // Case terminée → case suivante
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
          // Mini-cycle : redescente
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

  // GPS ZED-F9P via I2C
  Wire.begin(GPS_SDA, GPS_SCL);
  if (!gps.begin()) {
    Serial.println("[GPS] ZED-F9P non détecté — vérifier câblage I2C");
  } else {
    gps.setI2COutput(COM_TYPE_UBX);
    gps.setNavigationFrequency(GPS_FREQ);
    gps.setAutoPVT(true);
    Serial.println("[GPS] ZED-F9P OK — " + String(GPS_FREQ) + "Hz");
  }

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

  // Lecture position GPS
  readGPS();

  // Boucle robot
  if (robotState != STATE_IDLE && robotState != STATE_PAUSED && robotState != STATE_DONE) {
    robotTick(dt);
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
