const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('User Endpoints', () => {

  let ownerToken = '';
  let userId = 'TestingUser';

  beforeAll(async () => {
    const ownerResponse = await supertest(app).post('/api/user/login')
      .send({
        username: process.env.OWNER_USERNAME || 'jesuit-catalogs-owner',
        password: process.env.OWNER_PASSWORD || 'password'
      });
    ownerToken = ownerResponse.body.token;
  });

  afterAll(async () => {
    await requestWithSupertest.delete(`/api/user/delete/${userId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('POST /api/user/login should log a user in', async () => {
    const username = process.env.OWNER_USERNAME !== undefined ? process.env.OWNER_USERNAME : 'jesuit-catalogs-owner';
    const password = process.env.OWNER_PASSWORD !== undefined ? process.env.OWNER_PASSWORD : 'password';
    const res = await requestWithSupertest.post('/api/user/login')
      .send({
        username: username,
        password: password
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('data');
  });

  it('POST /api/user/login should reject an improper user login', async () => {
    const username = process.env.OWNER_USERNAME !== undefined ? process.env.OWNER_USERNAME : 'jesuit-catalogs-owner';
    const password = 'xyz';
    const res = await requestWithSupertest.post('/api/user/login')
      .send({
        username: username,
        password: password
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'User not found or password incorrect');
  });

  it('POST /api/user/login should require a username', async () => {
    const password = process.env.OWNER_PASSWORD !== undefined ? process.env.OWNER_PASSWORD : 'password';
    const res = await requestWithSupertest.post('/api/user/login')
      .send({
        password: password
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Must contain a \'username\'!');
  });

  it('POST /api/user/login require a password', async () => {
    const username = process.env.OWNER_USERNAME !== undefined ? process.env.OWNER_USERNAME : 'jesuit-catalogs-owner';
    const res = await requestWithSupertest.post('/api/user/login')
      .send({
        username: username
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Must contain a \'password\'!');
  });
  
});