// This file is needed for Render to recognize this as a Node.js project
import app from './index.js';

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
