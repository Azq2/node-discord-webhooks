const	DiscordWebhook		= require('./src/DiscordWebhook.js'), 
		stripJsonComments	= require('strip-json-comments'), 
		fs					= require('fs'), 
		parseArgv			= require('minimist');

main();

function main() {
	let args = parseArgv(process.argv);
	let config_file = args.config ? args.config : "./config.json";
	
	if (!fs.existsSync(config_file)) {
		console.error("Please, create config file " + config_file + " (see config.json.example for more info)");
		process.exit(1);
	}

	const config = JSON.parse(stripJsonComments(fs.readFileSync(config_file).toString()));
	
	config.bots.forEach((bot, id) => {
		const app = new DiscordWebhook(config, id);
		app.run();
	});
}
