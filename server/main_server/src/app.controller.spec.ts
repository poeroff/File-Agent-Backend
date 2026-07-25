import { AppController } from './app.controller';

describe('AppController', () => {
  it('responds to the healthcheck', () => {
    expect(new AppController().getHealth()).toBe('ok');
  });
});
