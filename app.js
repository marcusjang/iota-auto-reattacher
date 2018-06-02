const IRI_PORT = 14265;
const EXT_PORT = 14266;
const DEPTH = 4;
const MAINNET_MWM = 14;
const REATTACH_MAX_COUNT = 5;
const INTERVAL = 15 * 60 * 1000 // 15 minutes

const PROVIDER = 'http://localhost:' + IRI_PORT;

/**
*		iota.lib.js initialization with promisify to make our lives easier
**/
const IOTA = require('iota.lib.js');
const iota = new IOTA({ provider: PROVIDER });
const Promise = require('bluebird');
Promise.promisifyAll(iota.api);

console.log(iota.api.promoteTransactionAsync);

class Bundle {
	constructor(trytesArray) {
		const firstTx = iota.utils.transactionObject(trytesArray[0]);
		const tail = trytesArray
			.map(trytes => { return iota.utils.transactionObject(trytes); })
			.find(tx => { return tx.currentIndex === 0; });
		this.hash = firstTx ? firstTx.bundle : undefined;
		this.tail = tail;
		this.length = trytesArray.length > 4 ? trytesArray.length : 4;
		this.counter = 0;
		this.isConfirmed = false;
		this.interval = null;
	}

	async inclusionCheck() {
		const txs = await iota.api.findTransactionsAsync({
			bundles: [ this.hash ],
			addresses: [ this.tail.address ]
		});
		const info = await iota.api.getNodeInfoAsync();
		const lmi = info.latestMilestone;
		const states = await iota.api.getInclusionStatesAsync(txs, [ lmi ]);
		this.isConfirmed = states.includes(true);
		return this.isConfirmed;
	}

	addToQueue() {
		tLog(`A new transfer detected. BUNDLE: ${this.hash}`);
		if (this.tail.value === 0) {
			tLog('Ignoring zero value transactions...');
		} else {
			this.interval = setInterval(async bundle => {
				tLog(`TRY: ${bundle.counter}/${REATTACH_MAX_COUNT}, BUNDLE: ${bundle.hash.substr(0, 10)}...`);
				tLog(`  ┣ Checking the inclusion state...`);
				await bundle.inclusionCheck();
				if (bundle.isConfirmed || bundle.counter >= REATTACH_MAX_COUNT) {
					clearInterval(bundle.interval);
					if (bundle.isConfirmed) {
						tLog(`  ┗ The bundle is confirmed!`);
					} else {
						tLog(`  ┗ This bundle has exceeded the reattach max counter.`);
					}
				} else {
					bundle.counter++;
					try {
						tLog(`  ┣ Reattaching the bundle...`);
						const start = Date.now();
						const reattach = await iota.api.replayBundleAsync(bundle.tail.hash, DEPTH, MAINNET_MWM);
						tLog(`  ┣ Bundle successfully reattached. Time taken: ${(Date.now() - start)/1000}s`);
						const newTail = reattach.find(tx => { return tx.currentIndex === 0; });
						tLog(`  ┣ New tail hash: ${newTail.hash}`);
						tLog(`  ┗ Promoting the tail hash. Total number of promotes: ${bundle.length}...`);
						(function loop(i) {
							setTimeout(async (bundle, newTail) => {
								try {
									const promote = await iota.api.promoteTransactionAsync(newTail.hash, DEPTH, MAINNET_MWM, { address: newTail.address, value: 0 }, {});
								} catch(err) {
									tLog(`    ┗ Something went wrong while promoting... Commencing.`);
								}
								tLog(`    ┗ Promote ${bundle.length - i + 1}/${bundle.length}, TX: ${promote.hash}`);
								if (--i) look(i);
							}, 1000, bundle, newTail);
						})(bundle.length);
					} catch (err) {
						tlog('ERROR: ' + err.message);
					}
				}
			}, INTERVAL, this);
		}
	}
}

const tLog = msg => {
	console.log((new Date()).toLocaleString(), msg);
};

const validateTrytes = trytes => {
	if (!Array.isArray(trytes) || !iota.valid.isArrayOfTrytes(trytes)) {
		throw new Error('Invalid Trytes provided');
	}
};

const sortedTrytes = trytes => {
	const txs = trytes.map(tx => {
		return iota.utils.transactionObject(tx);
	});

	const bundles = txs
		// leave only the bundle hash
		.map(tx => {
			return tx.bundle;
		})
		// and leave only unique bundles
		.filter((tx, index, self) => {
			return self.indexOf(tx) === index;
		});

	if (bundles.length === 1) {
		return [ trytes ];
	} else {
		const sortedTrytes = [];
		bundles.forEach(bundleHash => {
			const bundle = [];
			txs.forEach((tx, index) => {
				if (tx.bundle === bundleHash) {
					bundle.push(trytes[index]);
				}
			});
			sortedTrytes.push(bundle);
		});
		return sortedTrytes;
	}
};

/**
*		HTTP/HTTP Proxy configurations
**/
const http = require('http');
const httpProxy = require('http-proxy');
const proxy = httpProxy.createProxyServer({ target: PROVIDER });

/**
*		The App
**/
const server = http.createServer((req, res) => {
	proxy.web(req, res);

	let data = '';
	if(req.method === 'POST') {
		req.on('data', (chunk) => {
			data += chunk;
			// If data is too long reject the request
			if(data.length > 1e6) {
				data = '';
				res.writeHead(413, {'Content-Type': 'text/plain'}).end();
				req.connection.destroy();
			}
		});

		req.on('end', async () => {
			if(req.headers['x-iota-api-version']) {
				const body = JSON.parse(data);
				if (body.command === 'attachToTangle' || body.command === 'storeTransactions') {
					try {
						validateTrytes(body.trytes);
						const trytesArray = sortedTrytes(body.trytes);
						trytesArray.forEach(trytes => {
							const bundle = new Bundle(trytes);
							bundle.addToQueue();
						});
					} catch (err) {
						console.error(err);
					}
				}
			}
		});
	}
});

server.listen(EXT_PORT);
tLog(`Listening on port ${EXT_PORT}`);
tLog(`IRI provider: ${PROVIDER}`);
