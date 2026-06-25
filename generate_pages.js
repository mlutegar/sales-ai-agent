const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'templates', 'index.html'), 'utf8');

const pages = [
  { name: 'Dashboard', id: 'tab-dashboard' },
  { name: 'RLHF', id: 'tab-rlhf' },
  { name: 'RAG', id: 'tab-rag' },
  { name: 'GoldenCases', id: 'tab-golden' },
  { name: 'Agenda', id: 'tab-agenda' },
  { name: 'LGPD', id: 'tab-lgpd' },
  { name: 'Metrics', id: 'tab-metrics' },
  { name: 'FollowUps', id: 'tab-followup' }
];

function extractTabContent(htmlStr, tabId) {
  const startStr = `<div id="${tabId}"`;
  const startIndex = htmlStr.indexOf(startStr);
  if (startIndex === -1) return '';

  let depth = 0;
  let endIndex = -1;
  let inString = false;
  let stringChar = '';

  for (let i = startIndex; i < htmlStr.length; i++) {
    const char = htmlStr[i];
    
    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      continue;
    }

    if (htmlStr.slice(i, i + 4) === '<div') {
      depth++;
    } else if (htmlStr.slice(i, i + 5) === '</div') {
      depth--;
      if (depth === 0) {
        endIndex = i + 6; // include </div>
        break;
      }
    }
  }
  
  if (endIndex !== -1) {
    return htmlStr.slice(startIndex, endIndex);
  }
  return '';
}

function htmlToJsx(htmlStr) {
  let jsx = htmlStr;
  
  // Replace class= with className=
  jsx = jsx.replace(/class=/g, 'className=');
  // Replace for= with htmlFor=
  jsx = jsx.replace(/for=/g, 'htmlFor=');
  
  // Make inputs self-closing
  jsx = jsx.replace(/(<input[^>]+)(?<!\/)>/g, '$1 />');
  // Make img self-closing
  jsx = jsx.replace(/(<img[^>]+)(?<!\/)>/g, '$1 />');
  // Make hr self-closing
  jsx = jsx.replace(/<hr>/g, '<hr />');
  // Make br self-closing
  jsx = jsx.replace(/<br>/g, '<br />');

  // Strip inline event handlers like onclick="fn()"
  jsx = jsx.replace(/\sonclick="[^"]*"/g, '');
  jsx = jsx.replace(/\sonchange="[^"]*"/g, '');
  
  // Strip inline styles (since converting them to JS objects automatically is hard)
  // For basic UI we'll just drop inline styles, or handle simple ones.
  // We can just keep basic ones or strip them to avoid errors.
  jsx = jsx.replace(/\sstyle="[^"]*"/g, '');

  // Comments in JSX
  jsx = jsx.replace(/<!--([\s\S]*?)-->/g, '{/* $1 */}');

  return jsx;
}

pages.forEach(page => {
  const content = extractTabContent(html, page.id);
  const jsxContent = htmlToJsx(content);
  
  const componentCode = `import React from 'react'
import { api } from '../api.js'

export default function ${page.name}({ toast, loadStats }) {
  return (
    <div className="tab-container">
      ${jsxContent || '<div>Em desenvolvimento...</div>'}
    </div>
  )
}
`;
  
  const targetPath = path.join(__dirname, 'frontend', 'src', 'pages', `${page.name}.jsx`);
  fs.writeFileSync(targetPath, componentCode, 'utf8');
  console.log(`Generated ${page.name}.jsx`);
});
