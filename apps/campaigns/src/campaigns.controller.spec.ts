import { Test, TestingModule } from '@nestjs/testing';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsService } from './campaigns.service.js';

describe('CampaignsController', () => {
  let campaignsController: CampaignsController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [CampaignsController],
      providers: [CampaignsService],
    }).compile();

    campaignsController = app.get<CampaignsController>(CampaignsController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(campaignsController.getHello()).toBe('Hello World!');
    });
  });
});
