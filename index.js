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

const { ConversationalRetrievalQAChain } = require("langchain/chains");
const { BufferMemory } = require("langchain/memory");

const TextLoader = require("langchain/document_loaders/fs/text");

const { Blob } = require("buffer");

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
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const chainsMap = new Map();

async function getFileChain(roomId) {
  let chain = chainsMap.get(roomId);

  if (!chain) {
    const vectorStore = await loadRedisVectorStore("IM");

    const llm = new OpenAI({});
    chain = ConversationalRetrievalQAChain.fromLLM(
      llm,
      vectorStore.asRetriever(5),
      {
        returnSourceDocuments: true,
        memory: new BufferMemory({
          memoryKey: "chat_history",
          inputKey: "question", // The key for the input to the chain
          outputKey: "text", // The key for the final conversational output of the chain
          returnMessages: true, // If using with a chat model (e.g. gpt-3.5 or gpt-4)
        }),
        questionGeneratorChainOptions: {
          llm: llm,
        },
      }
    );

    chainsMap.set(roomId, chain);
  }

  return chain;
}

async function createEmbeddingsRedis(metaInfo) {
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
    lengthFunction: (doc) => doc.length,
  });

  const file = metaInfo.file;
  const buff = Buffer.from(file.buffer);
  const blob = new Blob([buff]);

  let loader;

  switch (file.mimetype) {
    case "application/pdf":
      loader = new PDFLoader(blob, {
        splitPages: true,
        textSplitter: textSplitter,
      });
      break;
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      loader = new DocxLoader(blob, {
        splitPages: true,
        textSplitter: textSplitter,
      });
      break;
    case "text/csv":
      loader = new CSVLoader(blob, {
        splitPages: true,
        textSplitter: textSplitter,
      });
      break;
    case "txt":
      loader = new TextLoader(blob, {
        splitPages: true,
        textSplitter: textSplitter,
      });
      break;
    default:
      throw new Error("File not supported");
  }

  const documents = await loader.load();


  documents.forEach((doc) => {
    // Existing metadata
    const existingMeta = doc.metadata || {};

    // Merge with new metadata
    doc.metadata = { ...existingMeta, ...metaInfo };
  });

  const vectorStore = await RedisVectorStore.fromDocuments(
    documents,
    hfEmbeddings,
    {
      redisClient: redisClient,
      indexName: "IM",
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

async function askPDF(chain, query, user) {
  result = await chain.call({ question: query });

  return result.text;
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


  const { file } = req.body;
  const user = { id: "1", name: "JoaoF" };

  const hasAccess = await checkAccessRights(file, user);
  if (hasAccess) {
    next(); 
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

  const filename = req.file.originalname;


  const id = uuidv4();

  const metaInfo = {
    file: req.file,
    room_ids: parsedRoomIds,
    roles_allowed: parsedRolesAllowed,
    filename: filename,
  };

  try {
    createEmbeddingsRedis(metaInfo);


    const document = new Document({
      id,
      file: filename,
      index_id: filename,
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
app.post("/files/ask", async (req, res) => {
  const { roomId, question } = req.body;

  //validate user
  const user = { role: "admin", room: 12 };

  try {
    // Save the file content or perform necessary operations
    // ...

    // Wait for the FaissStore to be loaded before performing the search

    //const vectorStore = await loadRedisVectorStore(file);
    const chain = await getFileChain(roomId);
    const results = await askPDF(chain, question, user);

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
