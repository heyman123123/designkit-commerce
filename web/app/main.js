/* 工作台入口：装配路由 */

import { boot } from './shell.js';
import * as dashboard from './pages/dashboard.js';
import * as projects from './pages/projects.js';
import * as project from './pages/project.js';
import * as sku from './pages/sku.js';
import * as review from './pages/review.js';
import * as jobs from './pages/jobs.js';
import * as exportsPage from './pages/exports.js';
import * as usage from './pages/usage.js';
import * as members from './pages/members.js';
import * as settings from './pages/settings.js';

const routes = [
  ['/', dashboard.render],
  ['/projects', projects.render],
  ['/projects/:id', project.render],
  ['/skus/:id', sku.render],
  ['/review', review.render],
  ['/jobs', jobs.render],
  ['/exports', exportsPage.render],
  ['/usage', usage.render],
  ['/members', members.render],
  ['/settings', settings.render],
];

boot(routes);
