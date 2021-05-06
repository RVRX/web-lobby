var express = require('express');
const crypto = require('crypto');
var fs = require('fs');
var http = require('http');
const gameData = require('./gameData.js');
// var https = require('https');

// var bodyParser = require("body-parser");
var requestIp = require('request-ip');
const assert = require('assert');
const { json } = require('body-parser');

const logOpts = {
  fileNamePattern: 'log-<DATE>.log',
  logDirectory: 'logs',
  timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
  dateFormat: 'YYYY.MM.DD'
}
const log = require('simple-node-logger').createRollingFileLogger(logOpts);
var app = express()

function closeLobby(lobby_id, interval_id) {
  clearInterval(interval_id);
  delete lobbies[lobby_id];
}

function cleanLobbies() {
  // TODO
  // remove old unused lobbies.
  // console.log("Cleaning up lobbies.");
}
setInterval(cleanLobbies, 1000);

function verifyLobbyRequest(body) {
  assert('lobby_id' in body);
  assert('user_token' in body);
  assert('target_phase' in body);
  assert(body.lobby_id in lobbies);
  assert(body.user_token in lobbies[body.lobby_id].members);
  assert(Number.isInteger(body.target_phase));
}

class Lobby {
  constructor(timeline, round_time, team_size, password, moderated = false) {
    this.timeline = timeline;
    this.round_time = round_time;
    this.team_size = team_size;
    this.password = password;

    this.ruleset = {
      "round_time": round_time,
      "team_size": team_size,
      "timeline": timeline,
      "password": password,
      "moderated": moderated
    };

    this.phase = 0;
    this.paused = true;
    this.lastUsed = Date.now();
    this.phaseStartTime = Date.now();
    this.timer = this.round_time;

    do {
      this.lobby_id = crypto.randomBytes(4).toString('hex');
    } while (this.lobby_id in lobbies);

    console.log(`creating lobby ${this.lobby_id}`)

    this.members = {};
    this.pilots = {};
    this.ships = {};
    // for (let i=0; i<this.team_size; i++){
    //   this.ships.push([0, [0, 0, 0, 0]]);
    // }

    this.gun_bans = [];
    this.ship_bans = [];

    this.gun_ban_previews = [];
    this.ship_ban_previews = [];

    for (let i = 0; i < this.commandCount('gun-ban', this.timeline.length); i++) {
      // this.gun_bans.push(0);
      this.gun_ban_previews.push('0');
    }
    for (let i = 0; i < this.commandCount('ship-ban', this.timeline.length); i++) {
      // this.ship_bans.push(0);
      this.ship_ban_previews.push('1');
    }

    this.intervalId = setInterval(() => this.update(), 1000);
  }

  update() {
    // if (this.phase == 0 && Object.keys(this.pilots).length == this.team_size*2) {
    if (this.phase == 0) {
      this.phase = 1;
      this.phaseStartTime = Date.now();
    }
    if (this.phase >= 1) {
      let time = Date.now();
      if (time - this.phaseStartTime > this.round_time * 1000) {
        // Phase timed out.
        let activeCommand = this.getActiveCommand();
        // Check if ban timed out.
        if (activeCommand == 'gun-ban') {
          this.gun_bans.push('-1');
        }
        if (activeCommand == 'ship-ban') {
          this.ship_bans.push('-1');
        }

        this.stepPhase();
      }
      this.timer = this.round_time - (time - this.phaseStartTime) / 1000;
    }

    // Make sure builds are valid.
    for (let i = 0; i < 2 * this.team_size; i++) {
      if (!(i in this.ships)) continue;

      // Only check non locked ships.
      if (this.timelineCheck(i, 'ship-gun-pick') < 0) continue;

      // Fix loadout if not valid.
      // if (!this.loadoutAllowed(this.ships[i][0], this.ships[i][1])) {
      //   console.log("fixing loadout");
      this.ships[i] = this.legalizeLoadout(this.ships[i][0], this.ships[i][1]);
      // console.log(this.ships[i][0])
      // }
    }
    // return ships;

  }

  stepPhase() {
    this.phase += 1;
    this.phaseStartTime = Date.now();
    this.timer = this.round_time;
  }

  getActiveCommand() {
    if (this.phase >= this.timeline.length) return 'ended';
    let args = this.timeline[this.phase].split(' ');
    if (args.length == 1) return args[0];
    if (args.length == 2) return args[1];
    return this.timeline[this.phase];
  }



  addMember(role, name) {
    let user_token;
    do {
      user_token = crypto.randomBytes(4).toString('hex');
    } while (user_token in this.members);

    // Roles
    // >= 0 pilot
    // -1 t2 crew
    // -2 t1 crew
    // -3 spectator
    // -4 moderator
    // Check if role is taken.
    if (role >= 0) {
      for (const [token, member] of Object.entries(this.members)) {
        if (member.role == role) return false;
      }
    }

    this.members[user_token] = {
      "token": user_token,
      "role": role,
      "name": name
    };
    if (role >= 0) {
      this.pilots[role] = this.members[user_token];
      this.ships[role] = this.legalizeLoadout(0, []);
    }

    return user_token;
  }

  timelineCheck(role, command, target_phase) {
    // Returns:
    //  0 role+command is current phase
    // >0 role+command is future phase
    // <0 role+command is past phase
    let timelineStr = `T${role % 2 == 0 ? "1" : "2"}S${(role - (role % 2)) / 2 + 1} ${command}`;

    if (target_phase == undefined) target_phase = this.timeline.indexOf(timelineStr);
    if (this.timeline[target_phase] != timelineStr) return -1;

    // let targetPhase = this.timeline.indexOf(timelineStr);
    return target_phase - this.phase;
  }

  commandCount(query_command, target_phase) {
    // Return the number of times the command occurs in the timeline before phase.
    let endIdx = Math.min(target_phase, this.timeline.length);
    let count = 0;
    for (let i = 0; i < endIdx; i++) {
      let [target, command] = this.timeline[i].split(' ');
      if (command == undefined) command = target;
      if (command == query_command) count++;
    }
    return count;
  }

  legalizeLoadout(ship, guns) {
    // Update loadout to conform by active restrictions.
    // TODO: doesnt care about heavy/light guns.

    ship = String(ship);

    let shipbanCount = this.commandCount('ship-ban', this.phase);
    let gunbanCount = this.commandCount('gun-ban', this.phase);
    let ship_bans = this.ship_bans.slice(0, shipbanCount);
    let gun_bans = this.gun_bans.slice(0, gunbanCount);
    ship_bans.push('0');

    let first_allowed_light_gun = -1;
    let first_allowed_heavy_gun = -1;
    let first_allowed_ship = -1;

    for (const [key, value] of Object.entries(gameData.guns)) {
      if (!gun_bans.includes(key) && value.gun_type == 'LIGHT') {
        first_allowed_light_gun = key;
        break;
      }
    }
    for (const [key, value] of Object.entries(gameData.guns)) {
      if (!gun_bans.includes(key) && value.gun_type == 'HEAVY') {
        first_allowed_heavy_gun = key;
        break;
      }
    }
    for (const [key, value] of Object.entries(gameData.ships)) {
      if (!ship_bans.includes(key)) {
        first_allowed_ship = key;
        break;
      }
    }

    let guns_out = [];


    if (ship_bans.includes(String(ship))) {
      ship = first_allowed_ship;
      // guns = [];
      for (let i = 0; i < gameData.ships[ship].guns.length; i++) {
        if (gameData.ships[ship].guns[i] == 'LIGHT')
          guns_out.push(first_allowed_light_gun);
        else
          guns_out.push(first_allowed_heavy_gun);
      }
      return [ship, guns_out];
    }
    // Fix banned guns
    for (let i = 0; i < gameData.ships[ship].guns.length; i++) {
      // Banned gun
      if ( gun_bans.includes(String(guns[i])) ||
           !(String(guns[i]) in gameData.guns) || 
           gameData.ships[ship].guns[i] != gameData.guns[guns[i]].gun_type) {
        if (gameData.ships[ship].guns[i] == 'LIGHT')
          guns_out.push(first_allowed_light_gun);
        else
          guns_out.push(first_allowed_heavy_gun);
        // guns[i] = first_allowed_light_gun;
      }
      else
        guns_out.push(String(guns[i]));
    }
    return [ship, guns_out];
  }

  updateLoadout(loadout, user_token, target_phase) {
    loadout[0] = String(loadout[0]);
    loadout[1] = loadout[1].map(String);

    let shipIdx = this.members[user_token].role;
    if (shipIdx < 0) return;
    // if (this.isLocked(shipIdx)) return;
    if (this.timelineCheck(shipIdx, 'ship-gun-pick', target_phase) < 0) return;
    loadout = this.legalizeLoadout(loadout[0], loadout[1]);
    // if (!this.loadoutAllowed(loadout[0], loadout[1])) return;
    let ship = String(loadout[0]);
    if (!(ship in gameData.ships)) return;
    let guns = [];

    for (let i=0; i<gameData.ships[ship].guns.length; i++){
      let gun = loadout[1][i];
      if (!(gun in gameData.guns)) return;
      guns.push(String(gun));
    }
    this.ships[shipIdx] = [ship, guns];
  }

  lockLoadout(user_token, target_phase) {
    // Confirm the active loadout phase.
    let shipIdx = this.members[user_token].role;
    if (shipIdx < 0) return;
    if (this.timelineCheck(shipIdx, 'ship-gun-pick', target_phase) != 0) return;
    this.stepPhase();
  }

  updateGunBan(user_token, target_phase, gun) {
    let shipIdx = this.members[user_token].role;
    if (shipIdx < 0) return;
    if (this.timelineCheck(shipIdx, 'gun-ban', target_phase) != 0) return;
    if (gun == 0) return;
    let banIdx = this.commandCount('gun-ban', target_phase);
    this.gun_ban_previews[banIdx] = String(gun);
  }

  updateShipBan(user_token, target_phase, ship) {
    // Update ban preview selection.
    let shipIdx = this.members[user_token].role;
    if (shipIdx < 0) return;
    if (this.timelineCheck(shipIdx, 'ship-ban', target_phase) != 0) return;
    if (ship == 0) return;
    let banIdx = this.commandCount('ship-ban', target_phase);
    this.ship_ban_previews[banIdx] = String(ship);
  }

  lockBan(user_token, target_phase) {
    // Confirm the currently active ban.
    let shipIdx = this.members[user_token].role;
    if (shipIdx < 0) return;

    let isShipBan = this.timelineCheck(shipIdx, 'ship-ban', target_phase) == 0;
    let isGunBan = this.timelineCheck(shipIdx, 'gun-ban', target_phase) == 0;
    if (!isShipBan && !isGunBan) return;

    if (isShipBan) {
      let banIdx = this.commandCount('ship-ban', target_phase);
      this.ship_bans.push(this.ship_ban_previews[banIdx]);
    }
    if (isGunBan) {
      let banIdx = this.commandCount('gun-ban', target_phase);
      this.gun_bans.push(this.gun_ban_previews[banIdx]);
    }
    this.stepPhase();
  }

  skipBan(user_token, target_phase) {
    // Skip the currently active ban phase
    let shipIdx = this.members[user_token].role;
    if (shipIdx < 0) return;

    let isGunBan = this.timelineCheck(shipIdx, 'gun-ban', target_phase) == 0;
    let isShipBan = this.timelineCheck(shipIdx, 'ship-ban', target_phase) == 0;
    if (!isGunBan && !isShipBan) return;

    let command = isGunBan ? 'gun-ban' : 'ship-ban';
    let banIdx = this.commandCount(command, target_phase);
    if (isGunBan) this.gun_bans[banIdx] = '-1';
    else this.ship_bans[banIdx] = '-1';

    this.stepPhase();
  }

  getNameList() {
    // Return array of pilot names
    let names = [];
    for (let i = 0; i < 2 * this.team_size; i++) {
      if (i in this.pilots) names.push(this.pilots[i].name);
      else names.push("NOT JOINED");
    }
    return names;
  }

  getShipList(role) {
    // Return the loadouts as viewed by specified role.
    let ships = [];

    // Spectator or moderator gets full info.
    if (role == -3 || role == -4){
      for (let i = 0; i < 2 * this.team_size; i++) {
        if (i in this.ships) ships.push(this.ships[i]);
        else ships.push([0, []]);
      }
      return ships;
    }

    let team = Math.abs(role%2);

    // Teams gets team info + locked/picking ships
    for (let i = 0; i < 2 * this.team_size; i++) {
      if (i in this.ships){
        if (i%2 == team){
          ships.push(this.ships[i]);
        }
        else if (this.timelineCheck(i, 'ship-gun-pick') <= 0){
          ships.push(this.ships[i]);
        }
        else {
          ships.push([0, []]);
        }
      }
      else {
        ships.push([0, []]);
      }
    }
    
    return ships;
  }

  getShipBans() {
    let shipBans = [];
    let count = 0;
    for (let i = 0; i < this.ship_bans.length; i++) {
      shipBans.push(this.ship_bans[i]);
    }
    for (let i = this.ship_bans.length; i < this.ship_ban_previews.length; i++) {
      shipBans.push(this.ship_ban_previews[i]);
    }
    return shipBans;
  }
  getGunBans() {
    let shipBans = [];
    let count = 0;
    for (let i = 0; i < this.gun_bans.length; i++) {
      shipBans.push(this.gun_bans[i]);
    }
    for (let i = this.gun_bans.length; i < this.gun_ban_previews.length; i++) {
      shipBans.push(this.gun_ban_previews[i]);
    }
    return shipBans;
  }

  lobbyState(user_token) {
    let user_role = this.members[user_token].role;
    //TODO: only send enemy loadout when locked or picking.
    console.log(JSON.stringify(this.getShipList(user_role)));
    return {
      "timer": Math.floor(this.timer),
      "phase": this.phase,
      "ships": this.getShipList(user_role),
      "ship_bans": this.getShipBans(),
      "gun_bans": this.getGunBans(),
      "names": this.getNameList()
    };
  }
}

var lobbies = {};

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));
app.use(express.static('public'));


app.get('/lobbyb', function (req, res) {
  let ip = requestIp.getClientIp(req);
  log.info(ip, " ping.");
  res.status(200).sendFile(__dirname + "/public/lobby.html");
  //   res.status(200).send("OK");
});

app.post('/create_lobby', function (req, res) {
  try {

    assert('ruleset' in req.body);
    let ruleset = req.body.ruleset;
    assert('round_time' in ruleset);
    assert(Number.isInteger(ruleset.round_time));

    assert('team_size' in ruleset);
    assert(Number.isInteger(ruleset.team_size));

    assert('password' in ruleset);
    assert(typeof ruleset.password == "string");
    assert(ruleset.password.length < 50);

    assert('moderated' in ruleset);
    assert(typeof ruleset.moderated == "boolean");

    assert('timeline' in ruleset);
    assert(Array.isArray(ruleset.timeline));
    assert(ruleset.timeline.length < 100);
    const allowed_commands = ['ship-ban', 'gun-ban', 'ship-gun-pick', 'pause'];
    const allowed_special_commands = ['pause', 'Waiting for pilots to join', 'Waiting for lobby start', 'moderator-start'];

    for (let i = 1; i < ruleset.timeline.length; i++) {
      // if (ruleset.timeline[i] == "Waiting for pilots to join") continue;
      // if (ruleset.timeline[i] == "Waiting for lobby start") continue;
      if (allowed_special_commands.includes(ruleset.timeline[i])) continue;
      let [target, command] = ruleset.timeline[i].split(' ');
      assert(target.charAt(0) == 'T');
      assert(target.charAt(2) == 'S');
      assert(/\d/.test(target.charAt(1)));
      assert(/\d/.test(target.charAt(3)));
      assert(allowed_commands.includes(command));
    }
  }
  catch {
    res.status(400).send("Invalid lobby creation parameters.");
    return;
  }
  if (Object.keys(lobbies).length > 500){
    res.status(400).send("Too many currently active lobbies.");
    return;
  }
  let lobby = new Lobby(req.body.ruleset.timeline, req.body.ruleset.round_time, req.body.ruleset.team_size, req.body.ruleset.password);
  lobbies[lobby.lobby_id] = lobby;
  console.log("Created lobby " + lobby.lobby_id);
  res.status(200).json({
    "lobby_id": lobby.lobby_id
  });
});

app.post('/join_lobby_1', function (req, res) {
  try {
    assert('lobby_id' in req.body);
    assert('password' in req.body);
  }
  catch {
    res.status(400).send("Failed to join lobby.");
    return;
  }
  let lobby_id = req.body.lobby_id;
  if (!(lobby_id in lobbies)) {
    res.status(400).send('Lobby with ID does not exist.');
    return;
  }
  let lobby = lobbies[lobby_id];
  console.log(lobby.password);
  console.log(req.body.password);
  if (lobby.password != req.body.password) {
    res.status(400).send('Invalid password.');
    return;
  }

  // TODO: return open roles.
  res.status(200).json({
    "lobby_id": lobby_id,
    "phase": lobbies[lobby_id].phase
  });
});

app.post('/join_lobby_2', function (req, res) {
  try {
    assert('lobby_id' in req.body);
    assert('username' in req.body);
    assert('role' in req.body);
    assert(req.body.lobby_id in lobbies);
  }
  catch {
    res.status(400).send("Failed to join lobby: Bad request.");
    return;
  }

  let lobby = lobbies[req.body.lobby_id];
  let token = lobby.addMember(req.body.role, req.body.username);

  if (!token) {
    res.status(400).send("Failed to join lobby: Role already taken.")
  }

  res.status(200).json({
    "token": token,
    "lobby_id": lobby.lobby_id,
    "ruleset": lobby.ruleset,
    "role": req.body.role
  });
});

app.post('/lobby_state', function (req, res) {
  try {
    assert('lobby_id' in req.body);
    assert('user_token' in req.body);
    assert(req.body.lobby_id in lobbies);
    assert(req.body.user_token in lobbies[req.body.lobby_id].members);
  }
  catch {
    res.status(400).send("Invalid lobby or credentials.");
    return;
  }
  let lobby = lobbies[req.body.lobby_id];

  res.status(200).json(lobby.lobbyState(req.body.user_token));
});

// Start HTTP server
var httpServer = http.createServer(app);
httpServer.listen(80);

app.post('/loadout_change', function (req, res) {
  try {
    verifyLobbyRequest(req.body);

    assert('loadout' in req.body);
    assert(Array.isArray(req.body.loadout));
    assert(Number.isInteger(req.body.loadout[0]));
    assert(Array.isArray(req.body.loadout[1]));
    for (let i = 0; i < req.body.loadout[1].length; i++) {
      assert(Number.isInteger(req.body.loadout[1][i]));
    }
  }
  catch {
    res.status(400).send();
    return;
  }

  lobbies[req.body.lobby_id].updateLoadout(req.body.loadout, req.body.user_token, req.body.target_phase);

  res.status(200).send("Loadout updated");
});

app.post('/lock_loadout', function (req, res) {
  try {
    verifyLobbyRequest(req.body);
  }
  catch {
    res.status(400).send();
    return;
  }

  lobbies[req.body.lobby_id].lockLoadout(req.body.user_token, req.body.target_phase);

  res.status(200).send("Loadout locked.");
});

app.post('/ban_ship', function (req, res) {
  try {
    verifyLobbyRequest(req.body);
    assert('ship' in req.body);
    assert(Number.isInteger(req.body.ship));
  }
  catch {
    res.status(400).send();
    return;
  }
  lobbies[req.body.lobby_id].updateShipBan(req.body.user_token, req.body.target_phase, req.body.ship);
  res.status(200).send("Gun ban updated");
});

app.post('/ban_gun', function (req, res) {
  try {
    verifyLobbyRequest(req.body);
    assert('gun' in req.body);
    assert(Number.isInteger(req.body.gun));
  }
  catch {
    res.status(400).send();
    return;
  }
  lobbies[req.body.lobby_id].updateGunBan(req.body.user_token, req.body.target_phase, req.body.gun);
  res.status(200).send("Gun ban updated");
});

app.post('/lock_ban', function (req, res) {
  try {
    verifyLobbyRequest(req.body);
  }
  catch {
    res.status(400).send();
    return;
  }
  // lobbies[req.body.lobby_id].updateGunBan(req.body.user_token, req.body.target_phase, req.body.gun);
  lobbies[req.body.lobby_id].lockBan(req.body.user_token, req.body.target_phase);
});

app.post('/skip_ban', function (req, res) {
  try {
    verifyLobbyRequest(req.body);
  }
  catch {
    res.status(400).send();
    return;
  }
  lobbies[req.body.lobby_id].skipBan(req.body.user_token, req.body.target_phase);
})