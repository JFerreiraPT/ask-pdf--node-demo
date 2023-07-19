require("dotenv").config();
const { OpenAI } = require("langchain/llms/openai");
const { loadQAStuffChain } = require("langchain/chains");
const { HuggingFaceInferenceEmbeddings } = require("langchain/embeddings/hf");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { MongoClient } = require("mongodb");
const mongoose = require("mongoose");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const bodyParser = require("body-parser");
const multer = require("multer");

const { RedisVectorStore } = require("langchain/vectorstores/redis");
const { createClient, createCluster } = require("redis");

const app = express();
const port = 3000;
app.use(bodyParser.json());

REDIS_URL = "redis://localhost:6379";

const redisClient = createClient({
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
});
redisClient.connect();

// Initialize FaissStore and HuggingFaceInferenceEmbeddings
const hfEmbeddings = new HuggingFaceInferenceEmbeddings();

// MongoDB connection
const mongoURI = "mongodb://localhost:27017/mydatabase"; // Replace with your MongoDB connection URI
const client = new MongoClient(mongoURI, { useUnifiedTopology: true });

// Mongoose setup
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });

// Mongoose models
const Document = mongoose.model(
  "Document",
  new mongoose.Schema({
    id: {
      type: String,
      required: true,
      unique: true,
    },
    file: {
      type: String,
      required: true,
      unique: true,
    },
    index_id: {
      type: String,
      required: true,
    },
    room_ids: {
      type: [String],
      required: true,
      default: [],
    },
    roles_allowed: {
      type: [String],
      default: [],
    },
    users_allowed: {
      type: [String],
      default: [],
    },
  })
);

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, ""); // Specify the directory where the uploaded files will be stored
  },
  filename: function (req, file, cb) {
    const originalFileName = file.originalname;
    const fileName = `${originalFileName}`;
    cb(null, fileName); // Set the file name
  },
});

const upload = multer({ storage: storage });

const getFilename = (filePath) => path.basename(filePath);


async function createEmbeddingsRedis(filePath) {
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
    lengthFunction: (doc) => doc.length,
  });

  const loader = new PDFLoader(filePath, {
    splitPages: true,
    textSplitter: textSplitter,
  });

  const documents = await loader.load();

  const vectorStore = await RedisVectorStore.fromDocuments(
    documents,
    hfEmbeddings,
    {
      redisClient: redisClient,
      indexName: filePath,
    }
  );

  return vectorStore;
}

async function loadRedisVectorStore(indexName) {
  const vectorStore = new RedisVectorStore(hfEmbeddings, {
    redisClient: redisClient,
    indexName: indexName,
  });
  return vectorStore;
}


async function askPDF(vectorStore, query) {
  const llm = new OpenAI({});
  const chain = loadQAStuffChain(llm, "stuff");

  
  const relevantDocs = await vectorStore.similaritySearch(query, 5);

  result = await chain.call({
    input_documents: relevantDocs,
    question: query,
  });
  return result;
}

/**
 *
 * AUTH
 */
async function checkAccessRights(file, user) {
  const allowedRoles = await getRolesAllowedForFile(file); // Retrieve allowed roles for the file from your database
  const userRoles = getUserRoles(user); // Retrieve roles of the user from your database

  const allowed = await isUserAllowedForFile(file, user);

  // Check if the user's roles intersect with the allowed roles
  const hasRoleAccess = userRoles.some((role) => allowedRoles.includes(role));

  console.log(hasRoleAccess, allowed);

  return hasRoleAccess || allowed;
}

function getUserRoles(user) {
  return ["admin"];
}

async function getRolesAllowedForFile(file) {
  try {
    const documents = await Document.find({ file: file });
    const rolesAllowed = documents.map((doc) => doc.roles_allowed);
    return rolesAllowed.length > 0 ? rolesAllowed[0] : [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

async function isUserAllowedForFile(file, user) {
  const document = await Document.findOne({
    file: file,
    users_allowed: user.id,
  }).exec();

  return document !== null;
}

// Express middleware to verify user authorization
async function authorizeUser(req, res, next) {
  // Implement your authorization logic here
  // You can use req.headers or req.session to retrieve user information

  const { file } = req.body;
  const user = { id: "1", name: "JoaoF" };

  const hasAccess = await checkAccessRights(file, user);
  if (hasAccess) {
    next(); // User is authorized, proceed to the next middleware or route handler
  } else {
    res.status(401).json({ message: "Unauthorized" });
  }
}


// Express route to add a file
app.post("/files", upload.single("file"), uploadFile);
async function uploadFile(req, res) {
  // Extract necessary information from the request body
  const { room_ids, roles_allowed, users_allowed } = req.body;

  // Parse the comma-separated strings into arrays
  const parsedRolesAllowed = roles_allowed.split(",");
  const parsedUsersAllowed = users_allowed.split(",");
  const parsedRoomIds = room_ids.split(",");

  const fileName = req.file.filename;

  const id = uuidv4();

  try {
    createEmbeddingsRedis(fileName);

    // Perform file saving logic here
    // Use the extracted information to create a new document in MongoDB

    const document = new Document({
      id,
      file: fileName,
      index_id: getFilename(fileName),
      room_ids: parsedRoomIds,
      roles_allowed: parsedRolesAllowed,
      users_allowed: parsedUsersAllowed,
    });

    await document.save();

    res.status(200).json({ message: "File added successfully", id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to save file" });
  }
}



// Express route to perform similarity search with authorization
app.post("/files/ask", authorizeUser, async (req, res) => {
  const { file, question } = req.body;

  try {
    // Save the file content or perform necessary operations
    // ...

    // Wait for the FaissStore to be loaded before performing the search

    const vectorStore = await loadRedisVectorStore(file);

    const results = await askPDF(vectorStore, question);

    res.status(200).json({ results });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
