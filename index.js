const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

const crypto = require("crypto");

const admin = require("firebase-admin");
// const serviceAccount = require("./firebase-adminsdk.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

//middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unathorized access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.7wb31kx.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  family: 4,
});

// ---- DB connection: connect once, cache the promise, reuse across requests ----
let dbPromise = null;
function connectDB() {
  if (!dbPromise) {
    dbPromise = client.connect().then(() => client.db("parcel_sync_db"));
  }
  return dbPromise;
}

// Attach db + collections to every request BEFORE any route runs.
// This is the key fix: routes below are always registered immediately,
// and this middleware just makes sure Mongo is ready before the route body runs.
app.use(async (req, res, next) => {
  // let the root route work even if this middleware is skipped for it
  if (req.path === "/") return next();

  try {
    const db = await connectDB();
    req.db = db;
    req.collections = {
      userCollection: db.collection("users"),
      parcelsCollection: db.collection("parcels"),
      paymentCollection: db.collection("payments"),
      riderCollection: db.collection("riders"),
      trackingsCollection: db.collection("trackings"),
    };
    next();
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    res.status(500).send({ message: "database connection failed" });
  }
});

const logTracking = async (trackingsCollection, trackingId, status) => {
  const log = {
    trackingId,
    status,
    details: status.split("_").join(" "),
    createdAt: new Date(),
  };
  const result = await trackingsCollection.insertOne(log);
  return result;
};

//verify admin before admin act
//must use after verifyFBToken middleware
const verifyAdmin = async (req, res, next) => {
  const email = req.decoded_email;
  const query = { email };
  const user = await req.collections.userCollection.findOne(query);

  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "forbidden Access" });
  }

  next();
};

const verifyRider = async (req, res, next) => {
  const email = req.decoded_email;
  const query = { email };
  const user = await req.collections.userCollection.findOne(query);

  if (!user || user.role !== "rider") {
    return res.status(403).send({ message: "forbidden Access" });
  }

  next();
};

// ================== ROUTES (always registered, top-level) ==================

app.get("/", (req, res) => {
  res.send("parcel-sync-server is running");
});

//users related apis
app.get("/users", verifyFBToken, async (req, res) => {
  const { userCollection } = req.collections;
  const searchText = req.query.searchText;
  const query = {};
  if (searchText) {
    query.$or = [{ displayName: { $regex: searchText, $options: "i" } }];
  }

  const cursor = userCollection.find(query).sort({ createdAt: -1 }).limit(5);
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/users/:id", async (req, res) => {});

app.get("/users/:email/role", async (req, res) => {
  const { userCollection } = req.collections;
  const email = req.params.email;
  const query = { email };
  const user = await userCollection.findOne(query);
  res.send({ role: user?.role || "user" });
});

app.get("/users/profile/:email", async (req, res) => {
  const { userCollection, riderCollection } = req.collections;
  const email = req.params.email;
  const user = await userCollection.findOne({ email });
  if (!user) {
    return res.status(404).send({ message: "user not found" });
  }

  let riderInfo = null;
  if (user.role === "rider") {
    riderInfo = await riderCollection.findOne({ riderEmail: email });
  }

  res.send({ ...user, riderInfo });
});

app.post("/users", async (req, res) => {
  const { userCollection } = req.collections;
  const user = req.body;
  user.role = "user";
  user.createdAt = new Date();
  const email = user.email;
  const userExists = await userCollection.findOne({ email });

  if (userExists) {
    return res.send({ message: "user exists" });
  }

  const result = await userCollection.insertOne(user);
  res.send(result);
});

app.patch("/users/:id/role", verifyFBToken, verifyAdmin, async (req, res) => {
  const { userCollection } = req.collections;
  const id = req.params.id;
  const roleInfo = req.body;
  const query = { _id: new ObjectId(id) };
  const updateDoc = {
    $set: {
      role: roleInfo.role,
    },
  };
  const result = await userCollection.updateOne(query, updateDoc);
  res.send(result);
});

//parcel api
app.get("/parcels", async (req, res) => {
  const { parcelsCollection } = req.collections;
  const query = {};
  const { email, deliveryStatus, riderAssigned } = req.query;

  if (email) {
    query.senderEmail = email;
  }

  if (deliveryStatus) {
    const statuses = deliveryStatus.split(","); // supports comma-separated list
    query.deliveryStatus =
      statuses.length > 1 ? { $in: statuses } : statuses[0];
  }

  if (riderAssigned === "true") {
    query.riderId = { $exists: true };
  }

  const options = { sort: { createdAt: -1 } };

  const cursor = parcelsCollection.find(query, options);
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/parcels/rider", async (req, res) => {
  const { parcelsCollection } = req.collections;
  const { riderEmail, deliveryStatus } = req.query;
  const query = {};

  if (riderEmail) {
    query.riderEmail = riderEmail;
  }

  if (deliveryStatus) {
    query.deliveryStatus = deliveryStatus;
  } else {
    query.deliveryStatus = { $nin: ["parcel_delivered"] };
  }

  const cursor = parcelsCollection.find(query);
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/parcels/:id", async (req, res) => {
  const { parcelsCollection } = req.collections;
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await parcelsCollection.findOne(query);
  res.send(result);
});

app.get("/parcel/delivery-status/stats", async (req, res) => {
  const { parcelsCollection } = req.collections;
  const pipeline = [
    {
      $group: {
        _id: "$deliveryStatus",
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        status: "$_id",
        count: 1,
      },
    },
  ];
  const result = await parcelsCollection.aggregate(pipeline).toArray();
  res.send(result);
});

app.post("/parcels", async (req, res) => {
  const { parcelsCollection, trackingsCollection } = req.collections;
  const parcel = req.body;
  //parcel created time
  const trackingId = generateTrackingId();
  parcel.createdAt = new Date();
  parcel.trackingId = trackingId;

  await logTracking(trackingsCollection, trackingId, "parcel_created");

  const result = await parcelsCollection.insertOne(parcel);
  res.send(result);
});

//need to rename this api according to client
app.patch("/parcels/:id", async (req, res) => {
  const { parcelsCollection, riderCollection, trackingsCollection } =
    req.collections;
  const { riderId, riderName, riderEmail, trackingId } = req.body;
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };

  const updateDoc = {
    $set: {
      deliveryStatus: "driver_assigned",
      riderId: riderId,
      riderName: riderName,
      riderEmail: riderEmail,
    },
  };
  const result = await parcelsCollection.updateOne(query, updateDoc);
  //update rider info
  const riderQuery = { _id: new ObjectId(riderId) };
  const riderUpdateDoc = {
    $set: {
      workStatus: "in_delivery",
    },
  };
  const riderResult = await riderCollection.updateOne(
    riderQuery,
    riderUpdateDoc,
  );
  //log tracking
  await logTracking(trackingsCollection, trackingId, "driver_assigned");

  res.send(riderResult);
});

// edit non-critical parcel details (only allowed before payment)
app.patch("/parcels/:id/details", async (req, res) => {
  const { parcelsCollection } = req.collections;
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };

  const parcel = await parcelsCollection.findOne(query);
  if (!parcel) {
    return res.status(404).send({ message: "parcel not found" });
  }
  if (parcel.paymentStatus === "paid") {
    return res.status(403).send({ message: "cannot edit a paid parcel" });
  }

  const {
    parcelName,
    senderName,
    senderAddress,
    senderPhoneNumber,
    receiverName,
    receiverAddress,
    receiverPhoneNumber,
  } = req.body;

  const updateDoc = {
    $set: {
      parcelName,
      senderName,
      senderAddress,
      senderPhoneNumber,
      receiverName,
      receiverAddress,
      receiverPhoneNumber,
    },
  };

  const result = await parcelsCollection.updateOne(query, updateDoc);
  res.send(result);
});

app.patch("/parcels/:id/status", async (req, res) => {
  const { parcelsCollection, riderCollection, trackingsCollection } =
    req.collections;
  const { deliveryStatus, riderId, trackingId } = req.body;
  const query = { _id: new ObjectId(req.params.id) };
  const updateDoc = {
    $set: {
      deliveryStatus: deliveryStatus,
    },
  };
  if (deliveryStatus === "parcel_delivered") {
    //update rider info
    const riderQuery = { _id: new ObjectId(riderId) };
    const riderUpdateDoc = {
      $set: {
        workStatus: "available",
      },
    };
    await riderCollection.updateOne(riderQuery, riderUpdateDoc);
  }

  const result = await parcelsCollection.updateOne(query, updateDoc);
  //log tracking
  await logTracking(trackingsCollection, trackingId, deliveryStatus);

  res.send(result);
});

app.delete("/parcels/:id", async (req, res) => {
  const { parcelsCollection } = req.collections;
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await parcelsCollection.deleteOne(query);
  res.send(result);
});

//payment related apis
app.post("/payment-checkout-session", async (req, res) => {
  const parcelInfo = req.body;
  const amount = parseInt(parcelInfo.cost) * 100;
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "USD",
          unit_amount: amount,
          product_data: {
            name: `Please pay for your parcel: ${parcelInfo.parcelName}`,
          },
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    metadata: {
      parcelId: parcelInfo.parcelId,
      trackingId: parcelInfo.trackingId,
      parcelName: parcelInfo.parcelName, // ✅ added this line
    },
    customer_email: parcelInfo.senderEmail,
    success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
  });
  res.send({ url: session.url });
});

app.patch("/payment-success", async (req, res) => {
  const { parcelsCollection, paymentCollection, trackingsCollection } =
    req.collections;
  const sessionId = req.query.session_id;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const transactionId = session.payment_intent;
  const query = { transactionId: transactionId };

  const paymentExist = await paymentCollection.findOne(query);

  if (paymentExist) {
    return res.send({
      message: "already exists",
      transactionId,
      trackingId: paymentExist.trackingId,
    });
  }

  const trackingId = session.metadata.trackingId;

  if (session.payment_status === "paid") {
    const id = session.metadata.parcelId;
    const query = { _id: new ObjectId(id) };
    const update = {
      $set: {
        paymentStatus: "paid",
        deliveryStatus: "pending-pickup",
      },
    };
    const result = await parcelsCollection.updateOne(query, update);

    const payment = {
      amount: session.amount_total / 100,
      currency: session.currency,
      customerEmail: session.customer_email,
      parcelId: session.metadata.parcelId,
      parcelName: session.metadata.parcelName,
      transactionId: session.payment_intent,
      paymentStatus: session.payment_status,
      paidAt: new Date(),
      trackingId: trackingId,
    };

    const resultPayment = await paymentCollection.insertOne(payment);

    await logTracking(trackingsCollection, trackingId, "parcel_paid");

    return res.send({
      success: true,
      modifyParcel: result,
      trackingId: trackingId,
      transactionId: session.payment_intent,
      paymentInfo: resultPayment,
    });
  }

  return res.send({ success: false });
});

app.get("/payments", verifyFBToken, async (req, res) => {
  const { paymentCollection } = req.collections;
  const email = req.query.email;
  const query = {};

  if (email) {
    query.customerEmail = email;

    //email check
    if (email !== req.decoded_email) {
      return res.status(403).send({ message: "forbidden access" });
    }
  }
  const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
  const result = await cursor.toArray();
  res.send(result);
});

//riders related apis
app.get("/riders", async (req, res) => {
  const { riderCollection } = req.collections;
  const { status, district, workStatus } = req.query;

  const query = {};

  if (status) {
    query.status = status;
  }
  if (district) {
    query.riderDistrict = district;
  }
  if (workStatus) {
    query.workStatus = workStatus;
  }
  const cursor = riderCollection.find(query);
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/riders/delivery-per-day", async (req, res) => {
  const { parcelsCollection } = req.collections;
  const email = req.query.email;
  const pipeline = [
    {
      $match: {
        riderEmail: email,
        deliveryStatus: "parcel_delivered",
      },
    },
    {
      $lookup: {
        from: "trackings",
        localField: "trackingId",
        foreignField: "trackingId",
        as: "parcel_trackings",
      },
    },
    {
      $unwind: "$parcel_trackings",
    },
    {
      $match: {
        "parcel_trackings.status": "parcel_delivered",
      },
    },
    {
      $addFields: {
        deliveryDay: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$parcel_trackings.createdAt",
          },
        },
      },
    },
    {
      $group: {
        _id: "$deliveryDay",
        deliveredCount: { $sum: 1 },
      },
    },
  ];
  const result = await parcelsCollection.aggregate(pipeline).toArray();
  res.send(result);
});

app.post("/riders", async (req, res) => {
  const { riderCollection } = req.collections;
  const rider = req.body;
  rider.status = "pending";
  rider.createdAt = new Date();

  const result = await riderCollection.insertOne(rider);
  res.send(result);
});

app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
  const { riderCollection, userCollection } = req.collections;
  const status = req.body.status;
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const updateDoc = {
    $set: {
      status: status,
      workStatus: "available",
    },
  };

  const result = await riderCollection.updateOne(query, updateDoc);

  if (status === "approved") {
    const email = req.body.email;
    const userQuery = { email };
    const updateUser = {
      $set: {
        role: "rider",
      },
    };
    await userCollection.updateOne(userQuery, updateUser);
  }
  res.send(result);
});

//tracking related apis
app.get("/trackings/:trackingId/logs", async (req, res) => {
  const { trackingsCollection } = req.collections;
  const trackingId = req.params.trackingId;
  const query = { trackingId };
  const result = await trackingsCollection.find(query).toArray();
  res.send(result);
});

app.get("/trackings/user/:email", async (req, res) => {
  const { parcelsCollection } = req.collections;
  const email = req.params.email;
  const pipeline = [
    { $match: { senderEmail: email } },
    {
      $lookup: {
        from: "trackings",
        localField: "trackingId",
        foreignField: "trackingId",
        as: "logs",
      },
    },
    { $unwind: "$logs" },
    {
      $project: {
        _id: "$logs._id",
        parcelName: 1,
        trackingId: 1,
        status: "$logs.status",
        details: "$logs.details",
        createdAt: "$logs.createdAt",
      },
    },
    { $sort: { createdAt: -1 } },
    { $limit: 10 },
  ];
  const result = await parcelsCollection.aggregate(pipeline).toArray();
  res.send(result);
});

// ================== END ROUTES ==================

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = app;
