var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var routes = require('./routes/index');
var orders = require('./routes/orders');  //process order requests
var mongo = require('mongodb'); 
var stripe = require('stripe')( "sk_test_BQokikJOvBiI2HlWgH4olfQ2");  //stripe testing

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

//set up mongdb connection
mongo.Db.connect("mongodb://localhost:27017/swiftGiftProj",{auto_reconnect:true}, function(err, db) {
    if(!err) {
	console.log("db connection OK!");
        
        //some functions to talk to backend db
        var dbController = {
            db: db,
            //create a new lead for this session
            createLead: function(funCallback) { 
                var leads = db.collection('leads');
	        leads.insert({
	            customer_id: null,
                    order_id: null,
                    numOfItems: 0,
                    dt_created: new Date().toJSON()
	        },{w:1},funCallback);
           },
           //create a new lead if it does not exist, otherwise use the existing lead
           createLeadIfNone: function(leadId, funCallback) {
               var leads = db.collection('leads');
               leads.findOne({_id: mongo.ObjectID.createFromHexString(leadId)}, function(err, lead) {
	           if(!err) {
		       if(lead != null) {
		           funCallback(err,[lead]);
		       } else {  //for any reason, create a new one
		           leads.insert({
			       customer_id: null,
                               order_id: null,
                               numOfItems: 0,
                               dt_created: new Date().toJSON()
		           },{w:1},funCallback);	    
		       }
	           } else {
		       funCallback(err, lead);
	           }
	       });
           },
           //update a lead
           updateLead: function(leadId, field, value, funCallback) {
               var leads = db.collection('leads');
               var updates = null;
               if(field == 'customerId') {
                   updates = {$set: {customer_id: mongo.ObjectID.createFromHexString(value)}};
               } else if(field == 'numOfItems') {
                   updates = {$set: {numOfItems: value}};
               } else if(field == '+numOfItems') {
                   updates = {$inc: {numOfItems: value}};
               } else if(field == 'orderId') {
                   updates = {$set: {order_id: mongo.ObjectID.createFromHexString(value)}}; 
               } else {
                   funCallback({message: 'invalid field for lead'}, null);
               }
               leads.update({_id: mongo.ObjectID.createFromHexString(leadId)}, updates, {w:1}, funCallback);    
           },
           //add items to cart
           addToCart: function(leadId, productId, quantity, funCallback) {
               var shoppingCart = db.collection('shoppingCart');
               shoppingCart.findOne({lead_id: mongo.ObjectID.createFromHexString(leadId), product_id: mongo.ObjectID.createFromHexString(productId)}, function(err, item) {
                   if(!err) {
                       if(item != null) { //inc the quantity
                           shoppingCart.update({_id: item._id}, {$inc: {quantity: quantity}}, {w:1}, funCallback);
                       } else { //add it
                           shoppingCart.insert({
                               lead_id: mongo.ObjectID.createFromHexString(leadId),
                               product_id: mongo.ObjectID.createFromHexString(productId),
                               quantity: quantity
                           },{w:1}, 
                           function(err, result) {
                               if(!err) {
                                   funCallback(null, 1);
                               } else {
                                   funCallback(err, result);
                               }
                           });
                       }
                   } else {
                       funCallback(err, item);
                   }
               });
           },
           //get cart items
           getItemsFromCart: function(leadId, funCallback) {
               var shoppingCart = db.collection('shoppingCart');
               var products     = db.collection('products');
               shoppingCart.find({lead_id: mongo.ObjectID.createFromHexString(leadId)}).toArray(function(err, items) {
                   if(!err) {
                       //get the item name and price from 'products'
                       var product_ids = [];
                       for(var i = 0; i < items.length; i++) {
                            product_ids.push(items[i].product_id);
                       } 
                       products.find({_id: {$in: product_ids}}).toArray(function(err, items_detail) {
                           if(!err) {
                               var item_rows = []
                               for(var i = 0; i < items_detail.length; i++) {
                                   for(var j = 0; j < items.length; j++) { 
                                       if(items[j].product_id.equals(items_detail[i]._id)) {
                                           item_rows.push({name: items_detail[i].name, price: items_detail[i].price, quantity: items[j].quantity});
                                           break;
                                       }
                                   }
                               }
                               funCallback(null, item_rows);
                           } else {
                               funCallback(err, items_details);
                           }
                       });
                   } else {
                       funCallback(err, items);
                   }
               });
           },
           //create an order in the order table
           createOrder: function(leadId, items, funCallback) {
               var leads  = db.collection('leads');
               var orders = db.collection('orders');
               var orderTotal = 0;
               for(var i = 0; i < items.length; i++) {
                   orderTotal += items[i].price * items[i].quantity;
               } 
               orders.insert({
                   lead_id: mongo.ObjectID.createFromHexString(leadId),
                   dt_created: new Date().toJSON(),
                   total: orderTotal,
                   items: items
               }, {w:1}, function(err, order) {
                   if(!err) { //update the lead to insert the order_id
                       leads.update({_id: mongo.ObjectID.createFromHexString(leadId)}, {$set: {order_id: order[0]._id}}, {w:1}, function(err, updateResult) {
                           if(!err && updateResult != 1) {
                               err = {message: 'order was created, but the lead was not correctly updated!'};
                           }
                           funCallback(err, order);
                       });
                   } else {
                       funCallback(err, order);
                   }
               });
           },  
           //get order history for a user
           getOrderHistory: function(customerId, startIdx, pageSize, funCallback) {
               var leads  = db.collection('leads');
               var orders = db.collection('orders');
               var customer_id = mongo.ObjectID.createFromHexString(customerId);
               var cursor = leads.find({customer_id: customer_id, order_id: {$ne: null}});
               cursor.count(function(err, numOfLeads) {
                 if(!err) {
                   cursor.skip(startIdx).limit(pageSize).toArray(function(err, leads) {
                       var lead_ids = [];
                       for(var i = 0; i < leads.length; i++) {
                           lead_ids.push(leads[i]._id);
                       }
                       orders.find({lead_id: {$in: lead_ids}}).toArray(function(err, orders) {
                           if(!err) {
                               funCallback(null, {totalPages: Math.ceil(numOfLeads/pageSize), totalOrders: numOfLeads, orders: orders});
                           } else {
                               funCallback(err, orders);
                           }
                       });
                   });
                 } else {
                   funCallback(err, numOfLeads);
                 }
               });
           },
           //login a user
           loginUser: function(leadId, credential, funCallback) {
               var customers    = db.collection('customers');
               var leads        = db.collection('leads');
               var shoppingCart = db.collection('shoppingCart');
               var lead_id   = mongo.ObjectID.createFromHexString(leadId);
              
               customers.findOne({email: credential.email, password: credential.password}, function(err, customer) {
                   if(!err) {
                       if(customer != null) { //login successfully
                           //find any unfulfilled from last login
                           leads.find({$or: [{_id: lead_id},{customer_id: customer._id, order_id: null}]}).toArray(function(err, prevLeads) {
                               if(!err) {  //combine all perevious shopping cart items
                                   var prevLead_ids   = [];
                                   var finalNumOfItems = 0;
                                   var numOfPrevLeads = 0;
                                   for(var i = 0; i < prevLeads.length; i++) {
                                       finalNumOfItems += prevLeads[i].numOfItems;
                                       if(prevLeads[i]._id.equals(lead_id))  continue; //do not count itself
                                       prevLead_ids.push(prevLeads[i]._id);
                                       numOfPrevLeads++;
                                   } 
                                   //delete old leads
                                   leads.remove({_id: {$in: prevLead_ids}},{w:1}, function(err, numOfRemoved) {
                                       if(!err) {
                                           if(numOfRemoved != numOfPrevLeads) { //something is wrong from deletion
                                               funCallback({message: "tried to remove " + numOfPrevLeads + " leads, but actually removed " + numOfRemoved}, numOfRemoved);
                                           } else {
                                               //consolidate the shopping cart
                                               prevLead_ids.push(lead_id);
                                               shoppingCart.find({lead_id: {$in: prevLead_ids}}).toArray(function(err, shoppingCartItems) {
                                                   if(!err) {
                                                       var newItems = [];
                                                       for(var i = 0; i < shoppingCartItems.length; i++) {
                                                           var foundItem = false;
                                                           for(var j = 0; j < newItems.length; j++) { //combine the same items
                                                               if(shoppingCartItems[i].product_id.equals(newItems[j].product_id) ) {
                                                                   newItems[j].quantity += shoppingCartItems[i].quantity;
                                                                   foundItem = true;
                                                                   break;
                                                               }
                                                           }
                                                           if(!foundItem) { //inset the item
                                                               newItems.push({lead_id: lead_id, product_id: shoppingCartItems[i].product_id, quantity: shoppingCartItems[i].quantity});
                                                           }
                                                       }
                                                       //remove old items and insert new items
                                                       shoppingCart.remove({lead_id: {$in: prevLead_ids}},{w:1}, function(err, sItemsRemoved) {
                                                           if(!err) {
                                                               shoppingCart.insert(newItems, {w:1}, function(err, inserts) {
                                                                   if(!err) {
                                                                       if(inserts.length != newItems.length) { //there some thing wrong in insertion
                                                                           funCallback({message: "suppose to insert " + newItems.length + ", acutally inserted " + inserts.length}, 0);
                                                                       } else {
                                                                           //update the total number of items currently in the cart
                                                                           leads.update({_id: lead_id},{$set: {numOfItems: finalNumOfItems, customer_id: customer._id}},{w:1},funCallback);
                                                                       }
                                                                   } else {
                                                                       funCallback(err, inserts);
                                                                   }
                                                               });
                                                           } else {
                                                               funCallback(err, sItemsRemoved);
                                                           }
                                                       });
                                                   } else {
                                                       funCallback(err, shoppingCartItems);
                                                   }
                                               });
                                           }
                                       } else {
                                           funCallback(err, numOfRemoved);
                                       }
                                   });
                               } else {
                                   funCallback(err, lastLead);
                               }
                           });
                       } else { //email/password does not matches
                           funCallback({message: 'email password can not be found'}, customer);
                       }
                   } else {
                       funCallback(err, customer);
                   }
               });
           }, 

           //create a user account
           createUser: function(leadId, credential, funCallback) {
               var customers = db.collection('customers');
               var leads     = db.collection('leads');
               var lead_id   = mongo.ObjectID.createFromHexString(leadId);
               customers.find({email: credential.email}).toArray(function(err, existCustomers) {
                   if(!err) {
                       if(existCustomers.length > 0) { //this account already exists
                           funCallback({message: "the customer email already exist"}, existCustomers);
                       } else {
                           customers.insert({email: credential.email, password: credential.password},{w:1},function(err, customer) {
                               if(!err) {
                                   if(customer != null) { //new customer created
                                       leads.update({_id: lead_id}, {$set: {customer_id: customer[0]._id}}, {w:1}, funCallback);
                                   } else { //customer creation failed
                                       funCallback({message: 'could not create a new customer account'}, customer);
                                   }
                               } else {
                                   funCallback(err, customer);
                               }
                           });
                       }
                   } else {
                       funCallback(err, existCustomers);
                   }
               });
           }
        };
        //just populate the "products" table with a product. Should not be used in production code
        var products = dbController.db.collection('products');
        testProduct_id = mongo.ObjectID.createFromHexString('54ac3a495ffcb5b0ab420b3e');
        products.findOne({_id: testProduct_id}, function(err, product) {
            if(!err) {
                if(product == null) {
                    products.insert({
	            _id: testProduct_id,
                    name: "ipad mini",
                    price: 299
	            },{w:1},function(err,result) {
                        if(err) {
                            console.log("failed to populate the 'products' table. Please manuall insert a product with _id = 54ac3a495ffcb5b0ab420b3e");
                        }
                    });
                }
            } else {
                console.log("failed to populate the 'products' table. Please manuall insert a product with _id = 54ac3a495ffcb5b0ab420b3e");
            }
        });
        //cookie exp. time
        var cookieExp = 60000;

	//forward global context to each request
	app.use(function(req, res, next) {
	    req.dbController = dbController;
            req.cookieExp = cookieExp;
            req.stripe = stripe;
	    next();
	});

	app.use('/', routes);
	app.use('/orders', orders);

	// catch 404 and forward to error handler
	app.use(function(req, res, next) {
	    var err = new Error('Not Found');
	    err.status = 404;
	    next(err);
	});

	// error handlers

	// development error handler
	// will print stacktrace
	if (app.get('env') === 'development') {
	    app.use(function(err, req, res, next) {
		res.status(err.status || 500);
		res.render('error', {
		    message: err.message,
		    error: err
		});
	    });
	}

	// production error handler
	// no stacktraces leaked to user
	app.use(function(err, req, res, next) {
	    res.status(err.status || 500);
	    res.render('error', {
		message: err.message,
		error: {}
	    });
	});

    } else {
	console.log("db connection failed!");
    }
});

module.exports = app;
