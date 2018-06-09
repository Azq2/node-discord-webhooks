const	http				= require('http'), 
		fetch				= require('node-fetch'), 
		stripJsonComments	= require('strip-json-comments'), 
		fs					= require('fs'), 
		os					= require('os'), 
		util				= require('util'), 
		WebSocket			= require('ws'), 
		dateFormat			= require('dateformat');

const OPCODE_DISPATCH					= 0;
const OPCODE_HEARTBEAT					= 1;
const OPCODE_IDENTIFY					= 2;
const OPCODE_STATUS_UPDATE				= 3;
const OPCODE_VOICE_STATE_UPDATE			= 4;
const OPCODE_VOICE_SERVER_PING			= 5;
const OPCODE_RESUME						= 6;
const OPCODE_RECONNECT					= 7;
const OPCODE_REQUEST_GUILDS_MEMBERS		= 8;
const OPCODE_INVALID_SESSION			= 9;
const OPCODE_HELLO						= 10;
const OPCODE_HEARTBEAT_ACK				= 11;

class DiscordWebhook {
	constructor(config, bot_id) {
		this.config = config;
		this.bot = this.config.bots[bot_id];
		
		if (this.config.stateDir) {
			this.state_file = this.config.stateDir + "/" + this.bot.token + ".json";
			
			if (!fs.existsSync(this.config.stateDir)) {
				var path = "";
				this.config.stateDir.split("/").forEach(function (part) {
					if (part != "." && part != "..") {
						if (!fs.existsSync(path))
							fs.mkdirSync(path);
					}
					path += part + "/";
				});
			}
		} else {
			this.state_file = os.tmpdir() + "/node-discord-webhook-" + this.bot.token + ".json";
		}
		
		if (fs.existsSync(this.state_file)) {
			try {
				this.state = JSON.parse(fs.readFileSync(this.state_file));
			} catch (e) { }
		}
		
		this.state = this.state || {};
	}
	
	async run() {
		let gateway = await fetch(this.config.api + "/gateway")
			.then(res => res.json());
		
		if (!gateway.url)
			throw new Error("Can't get gateway url: " + JSON.stringify(gateway));
		
		this.ws_url = gateway.url + "/?encoding=json";
		
		await this.connectWS();
	}
	
	startHeartbeat(timeout) {
		const self = this;
		
		self.log("start heartbeat interval %d", timeout);
		
		self.heartbeat = setInterval(function () {
			self.log("heartbeat...");
			self.heartbeat_start = Date.now();
			self.ws.send(JSON.stringify({
				op:		OPCODE_HEARTBEAT, 
				d:		'seq' in self.state ? self.state.seq : null
			}));
		}, timeout);
	}
	
	async syncState() {
		return util.promisify(fs.writeFile)(this.state_file, JSON.stringify(this.state));
	}
	
	async disconnectWS() {
		const self = this;
		
		if (self.ws) {
			self.ws.terminate();
			self.ws = null;
		}
		
		if (self.heartbeat) {
			clearInterval(self.heartbeat);
			self.heartbeat = null;
		}
	}
	
	async execWebhook(name, data) {
		const self = this;
		if (self.bot.webhooks[name]) {
			fetch(self.bot.webhooks[name].url, {
				method:		'POST',
				body:		JSON.stringify(data),
				headers:	{'Content-Type': 'application/json'}
			});
		}
	}
	
	async connectWS() {
		const self = this;
		
		self.log("connecting to %s", self.ws_url);
		let ws = new WebSocket(self.ws_url);
		
		ws.on('open', () => {
			self.log("gateway connected");
		});
		 
		ws.on('close', () => {
			self.log("gateway disconnected");
			
			self.ws = null;
			
			self.execWebhook("disconnected", {});
			
			// reconnect
			self.disconnectWS();
			self.connectWS();
		});
		 
		ws.on('message', (data) => {
			data = JSON.parse(data);
			
			switch (data.op) {
				case OPCODE_HELLO:
					// Init heartbeat
					self.startHeartbeat(data.d.heartbeat_interval);
					
					// We have saved session_id, try to restore
					if (self.state.session_id) {
						self.log("resume session %s", self.state.session_id);
						ws.send(JSON.stringify({
							op:		OPCODE_RESUME, 
							d:		{
								token:				self.bot.token, 
								session_id:			self.state.session_id, 
								seq:				self.state.seq
							}
						}));
					}
					// Do identify
					else {
						self.log("start new session");
						ws.send(JSON.stringify({
							op:		OPCODE_IDENTIFY, 
							d:		{
								token:				self.bot.token, 
								large_threshold:	250, 
								compress:			false, 
								properties:	{
									"$os":		os.platform(),
									"$browser":	"node-discord-webhook",
									"$device":	"node-discord-webhook"
								}
							}
						}));
					}
				break;
				
				case OPCODE_DISPATCH:
					self.state.seq = data.s;
					
					if (data.t == "READY") {
						self.state.session_id = data.d.session_id;
						self.log("new session %s ready", self.state.session_id);
						
						self.execWebhook("connected", {});
					}
					
					self.syncState();
					
					if (data.t == "RESUMED") {
						self.log("session resumed");
						
						self.execWebhook("connected", {});
					}
					
					if (self.bot.webhooks.events) {
						let exclude = self.bot.webhooks.exclude, 
							include = self.bot.webhooks.include;
						
						if (exclude && exclude.length > 0 && exclude.indexOf(data.t) >= 0) {
							self.log("skip event %s by exclude", data.t);
							break;
						}
						
						if (include && include.length > 0 && include.indexOf(data.t) < 0) {
							self.log("skip event %s by include", data.t);
							break;
						}
						
						self.log("send %s to webhook", data.t);
						self.execWebhook("events", data);
					} else {
						self.log("skip event %s", data.t);
					}
				break;
				
				case OPCODE_INVALID_SESSION:
					self.log("invalid session");
					
					// reset session id
					delete self.state.seq;
					delete self.state.session_id;
					self.syncState();
					
					// reconnect
					self.ws.terminate();
				break;
				
				case OPCODE_HEARTBEAT:
					self.log("force heartbeat...");
					self.ws.send(JSON.stringify({
						op:		OPCODE_HEARTBEAT, 
						d:		'seq' in self.state ? self.state.seq : null
					}));
					self.heartbeat_start = Date.now();
				break;
				
				case OPCODE_RECONNECT:
					// reconnect
					self.log("force reconnect");
					self.ws.terminate();
				break;
				
				case OPCODE_HEARTBEAT_ACK:
					self.log("heartbeat ack %s ms", +(Date.now() - self.heartbeat_start).toFixed(4));
				break;
			}
			
			if (self.config.verbose)
				console.error(data);
		});
		
		this.ws = ws;
	}
	
	log() {
		let message = util.format.apply(util, arguments);
		let now = new Date();
		console.error("[" + dateFormat(now, "yyyy-mm-dd HH:MM:ss") + "] <" + this.bot.name + "> " + message);
	}
};

module.exports = DiscordWebhook;
