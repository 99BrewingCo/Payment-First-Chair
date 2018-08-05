var crypto = require('crypto');
const functions = require('firebase-functions');
const admin = require('firebase-admin');

//  Square Connect API
const SquareConnect = require('square-connect');

// Configure OAuth2 access token for authorization: oauth2
var oauth2 = SquareConnect.ApiClient.instance.authentications['oauth2'];
oauth2.accessToken = functions.config().square.accesstoken;

let isValidSignature = function ($notificationBody, $notificationSignature, $notificationUrl, $webhookSignatureKey) {
	let hash = crypto.createHmac('sha1', $webhookSignatureKey).update($notificationUrl + $notificationBody);
	return (btoa(hash) == $notificationSignature)
}

exports.squareUpdate = functions.https.onRequest((request, response) => {
	let squareActionableData = {};

	let validWebhook = isValidSignature(request.body, request.get('X-Square-Signature'), request.protocol + '://' + request.get('host') + request.originalUrl, functions.config().someservice.id);
	console.log(validWebhook);

	let squareWebhookEvent = JSON.parse(request.body);

	squareActionableData.paymentId = squareWebhookEvent.entity_id;
	if (squareWebhookEvent.event_type == "PAYMENT_UPDATED"){
		// Fetch Payment Information
		var apiInstance = new SquareConnect.V1TransactionsApi();
		apiInstance.retrievePayment(squareWebhookEvent.location_id, squareWebhookEvent.entity_id).then(function(paymentData) {
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
			return apiInstance.retrieveTransaction(squareWebhookEvent.location_id, transactionId).then(function(transactionData) {
				// Pull Customer IDs from Transactions
				let customerIds = transactionData.transaction.tenders.map(tender => (tender.hasOwnProperty('customer_id'))? tender.customer_id : null);
				customerIds = customerIds.filter(customerId => customerId !== null);

				if (customerIds.length > 0){
					var apiInstance = new SquareConnect.CustomersApi();
					return apiInstance.retrieveCustomer(customerIds[0]).then(function(customerData) {
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
		}).then(function (data){
			console.log('finished with processed data', data);
			response.status(200).send('200 OK');
		}).catch(function(error) {
			console.error(error);
			response.status(500).send('500 Server Error');
		});
	}else {
		response.status(200).send('No Processing Required.');
	}
});
