// Config, DB, and HTTP requests
const { get, post } = require('snekfetch');
const { open } = require('sqlite');
const cfg = require('./config');

// Express stuff
const session = require('express-session');
const express = require('express');
const app = express();

app.use(session({
	secret: 'USe A GoOD SeCReT DIm',
	resave: false,
	saveUninitialized: true
}));

// Base64 Encode
const btoa = str => Buffer(str).toString('base64');

// Dates
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'November', 'October', 'December'];
const ordinal = num => {
	const s = ['th', 'st', 'nd', 'rd'],
				v = num % 100;
	return num + (s[(v - 20) % 10] || s[v] || s[0]);
};
const format = date => `${months[date.getMonth()]} ${ordinal(date.getDate() + 1)}, ${date.getFullYear()}`;

(async () => {
	// Database stuff
	const db = await open('./data.sqlite');
	await db.run(`
	CREATE TABLE IF NOT EXISTS users (
		id TINYTEXT,
		name TINYTEXT,
		subbed TINYTEXT
	)
	`);

	// App
	app.get('/verify', (req, res) => {
		const { discord, twitch } = req.session;
		if (discord && twitch) {
			db.get('SELECT * FROM users WHERE id = (?)', discord.id).then(user => {
				if (!user) db.run('INSERT INTO users (id, name, subbed) VALUES (?, ?, ?)', discord.id, twitch.name, twitch.subbed);
			});
		}
		const date = twitch && twitch.subbed ? new Date(twitch.subbed) : false;
		res.send([
			discord
				? `Logged in as ${discord.tag} (${discord.id}) on discordapp.com`
				: '<a href="/verify/discord/login">Login to Discord</a>',
			twitch
				? `Logged in as ${twitch.name} on twitch.tv`
				: '<a href="/verify/twitch/login">Login to Twitch</a>',
			date
				? `Subbed since ${format(date)}`
				: twitch
					? `You're not subbed to ${cfg.streamer} D:`
					: '',
			discord || twitch ? `<a href="#" onclick="if(confirm('Are you sure about that?'))window.location='/verify/logout'">Logout</a>` : ''
		].filter(s => s).join('<br>'));
	});
	
	app.get('/verify/logout', async (req, res) => {
		const { discord, twitch } = req.session;
		if (discord && twitch) {
			await db.run('DELETE FROM users WHERE id = (?)', discord.id);
			await db.close();
		}
		req.session.destroy();
		res.redirect('/verify');
	});
	
	app.get('/verify/api/:id', async (req, res) => {
		const user = await db.get('SELECT * FROM users WHERE id = (?)', req.params.id);
		if (user) res.json(user);
		else res.sendStatus(404);
	});
	
	app.get('/verify/:platform/:method', async (req, res) => {
		const { platform, method } = req.params;
	
		if (!['discord', 'twitch'].includes(platform)) return res.status(405).send('Invalid Platform');
		if (!['authorize', 'login'].includes(method)) return res.status(405).send('Invalid Method');
	
		const { code } = req.query;
		const callback = `${req.protocol}://${req.get('host')}/verify/${platform}/authorize`;
	
		if (platform === 'discord') {
			if (method === 'login') {
				return res.redirect([
					'https://discordapp.com/oauth2/authorize',
					`?client_id=${cfg.discord.id}`,
					'&scope=identify',
					'&response_type=code',
					`&callback_uri=${callback}`
				].join(''));
			} else {
				if (!code) return res.redirect('/verify');
				const cred = btoa(`${cfg.discord.id}:${cfg.discord.secret}`);
				const { body: auth } = await post(`https://discordapp.com/api/oauth2/token?grant_type=authorization_code&code=${code}`).set('Authorization', `Basic ${cred}`);
				const { body: info } = await get('https://discordapp.com/api/v6/users/@me').set('Authorization', `Bearer ${auth.access_token}`);
				req.session.discord = {
					tag: `${info.username}#${info.discriminator}`,
					id: info.id,
					token: auth.access_token
				};
			}
		} else {
			if (method === 'login') {
				return res.redirect([
					'https://api.twitch.tv/kraken/oauth2/authorize',
					`?client_id=${cfg.twitch.id}`,
					'&scope=user_read+user_subscriptions',
					'&response_type=code',
					`&redirect_uri=${callback}`
				].join(''));
			} else {
				if (!code || req.query.scope !== 'user_read user_subscriptions') return res.redirect('/verify');
				const { body: auth } = await post([
					'https://api.twitch.tv/kraken/oauth2/token',
					`?client_id=${cfg.twitch.id}`,
					`&client_secret=${cfg.twitch.secret}`,
					'&grant_type=authorization_code',
					`&code=${code}`,
					`&redirect_uri=${callback}`
				].join(''));
				const { body: info } = await get(`https://api.twitch.tv/kraken/user`).set('Authorization', `OAuth ${auth.access_token}`);
				req.session.twitch = {
					name: info.display_name,
					token: auth.access_token,
					subbed: await get(`https://api.twitch.tv/kraken/users/${info.name}/subscriptions/${cfg.streamer}`)
						.set('Authorization', `OAuth ${auth.access_token}`)
						.then(res => res.body.created_at)
						.catch(() => false)
				};
			}
		}
		res.redirect('/verify');
	});
	
	app.listen(cfg.port || 8080, () => console.log(`Listening on port ${cfg.port || 8080}`));
})();