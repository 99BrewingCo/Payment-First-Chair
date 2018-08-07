var crypto = require('crypto');
const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp(functions.config().firebase);
var db = admin.firestore();
db.settings({timestampsInSnapshots: true});

//  Square Connect API
const SquareConnect = require('square-connect');

// Configure OAuth2 access token for authorization: oauth2
var oauth2 = SquareConnect.ApiClient.instance.authentications['oauth2'];
oauth2.accessToken = functions.config().square.accesstoken;

let isValidSignature = function ($notificationBody, $notificationSignature, $notificationUrl, $webhookSignatureKey) {
	let hash = crypto.createHmac('sha1', $webhookSignatureKey).update($notificationUrl + $notificationBody);
	return (hash.digest('base64') === $notificationSignature);
}

let beerRecords = {
	"Frog Town IPA": {
		"brewer": "Frogtown",
		"id": 1,
		"name": "War On Sobriety"
	},
	"Angel City Pilsner": {
		"brewer": "Angel City",
		"id": 2,
		"name": "Pilsner"
	}
}

let getBeerRecordFromSquareName = function(name){
	return beerRecords[name] || {brewer: "Unknown", id: 0, name: "Unknown"};
}

exports.squareUpdate = functions.https.onRequest((request, response) => {
	if (request.method !== "POST") {
		response.set('Allow', 'POST');
		response.status(405).send('405 Method Not Allowed');
	} else {
		let squareActionableData = {};

		if (!isValidSignature(request.rawBody, request.get('X-Square-Signature'), functions.config().square.webhooksurl, functions.config().square.webhooksignaturekey)){
			response.status(401).send('401 Unauthorized');
		}else {
			squareActionableData.paymentId = request.body.entity_id;
			if (request.body.event_type === "PAYMENT_UPDATED"){
				// Fetch Payment Information
				var apiInstance = new SquareConnect.V1TransactionsApi();
				apiInstance.retrievePayment(request.body.location_id, request.body.entity_id).then(paymentData => {
					squareActionableData.createdAt = paymentData.created_at;

					// Discover Beers Purchased
					let items = paymentData.itemizations.map(item => item.name);
					items = items.filter(items => items !== 'Water Cup');
					squareActionableData.items = items;

					// Pull Transaction ID from Payment URL
					let transactionId = paymentData.payment_url.split('/');
						transactionId = transactionId[transactionId.length - 1 ];

					squareActionableData.transactionId = transactionId;

					var apiInstance = new SquareConnect.TransactionsApi();
					return apiInstance.retrieveTransaction(request.body.location_id, transactionId).then(transactionData => {
						// Pull Customer IDs from Transactions
						let customerIds = transactionData.transaction.tenders.map(tender => (tender.hasOwnProperty('customer_id'))? tender.customer_id : null);
						customerIds = customerIds.filter(customerId => customerId !== null);

						if (customerIds.length > 0){
							var apiInstance = new SquareConnect.CustomersApi();
							return apiInstance.retrieveCustomer(customerIds[0]).then(customerData => {
								// Pull Customer Name from Customers
								squareActionableData.first = customerData.customer.given_name;
								squareActionableData.last = customerData.customer.family_name;
								squareActionableData.display = `${customerData.customer.given_name} ${customerData.customer.family_name.charAt(0)}.`;

								return squareActionableData;
							});
						} else {
							return squareActionableData;
						}
					});
				}).then(squareData => {
					// Associate New Sale with Game Play
					return db.runTransaction(transaction => {
						var currentCountRef = db.collection("count").doc("current");
						// This code may get re-run multiple times if there are conflicts.
						return transaction.get(currentCountRef).then(currentCount => {
							if (!currentCount.exists) {
								return false;
							}
							// Pull First Name Pending Beer
							if (currentCount.data().namePending.length > 0){
								let namePending = currentCount.data().namePending;
								squareData.items.forEach(item => {
									let beer = namePending.shift();

									// Update Individual Beer Record
									transaction.update(beer.beer, {
										"beer": getBeerRecordFromSquareName(item),
										"events.name": true,
										"name": {
											"first": squareData.first,
											"last": squareData.last,
											"display": squareData.display,
										},
										"payment": {
											"timestamp": squareData.createdAt,
											"transaction": squareData.transactionId
										}
									});

									// Update Game Display Board
									transaction.update(db.collection("display").doc(beer.id.toString()), {
										"display.name": true,
										"name": {
											"first": squareData.first,
											"last": squareData.last,
											"display": squareData.display,
										},
									});
								});

								// Remove from Database
								transaction.update(currentCountRef, {
									namePending: namePending // Update name pending tracker
								});

								return true;
							} else {
								return false;
							}
						});
					});
				}).then(action => {
					if (action){
						response.status(200).send('200 OK');
					} else {
						response.status(400).send('400 No Pending Beer Tokens to Process');
					}
					return true;
				}).catch(error => {
					console.error(error);
					response.status(500).send('500 Server Error');
				});
			} else {
				response.status(200).send('No Processing Required.');
			}
		}
	}
});
